import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { applyVariantSlots, resolveBacktestTarget } from "@/lib/ui/adapters/engines";
import { shadowVariants } from "@/lib/ui/queries";
import type { StrategyConfig } from "@/lib/contracts/strategy";

/**
 * 回测面板"跑哪一套"的解析。
 *
 * 这里要盯住的是那条断掉的支路：API 以前收了 strategyId / strategyVersion 却从不读它，
 * 一律跑当前 YAML —— 下拉里选哪个版本都一样，而影子盘的组合干脆没有入口。
 * 于是"我明明有九套组合，回测面板只给我 default 的三个版本"。
 *
 * 两份来源别混：strategy 表是 YAML 的历史快照（改一次存一份），
 * shadow_variant 是五个槽位的一套搭配。前者比"参数改了之后好不好"，后者比"换套打法好不好"。
 */

let dir: string, db: Database.Database;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "pt-target-"));
  db = new Database(path.join(dir, "t.db"));
  runMigrations(db);
});
afterEach(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });

const seed = (rows: Array<[string, string, string, string]>) => {
  const ins = db.prepare(
    "INSERT INTO shadow_variant (id, name, slot_config, status, created_at) VALUES (?, ?, ?, ?, '2026-09-23 00:00:00')"
  );
  for (const r of rows) ins.run(...r);
};

describe("applyVariantSlots", () => {
  const base = {
    id: "default", version: "1.4.0",
    槽位: { 择时器: { 用: "三档阈值", 参数: { 阈值: 40 } }, 评估器: { 用: "可配权重打分" } },
  } as unknown as StrategyConfig;

  it("盖掉变体指定的槽", () => {
    const out = applyVariantSlots(base, { 择时器: { 用: "五段状态机" } });
    expect((out.槽位 as any).择时器.用).toBe("五段状态机");
  });

  /**
   * 与影子盘同口径：变体没声明的槽落回 BASELINE，不继承 YAML 当前的 `槽位:`。
   * 影子盘把 v.slots 作为 slotConfig 显式入参，引擎对缺的槽取 BASELINE_CHOICE，YAML 的槽位整段不看。
   * 若这里继承 YAML，影子盘切换把某套槽写进 YAML 之后，回测里的 "baseline" 就不再是影子盘的 baseline。
   */
  it("变体没提的槽不继承 YAML —— 落回 BASELINE，与影子盘一致", () => {
    const out = applyVariantSlots(base, { 主线识别器: { 用: "申万聚集" } });
    expect(out.槽位).toEqual({ 主线识别器: { 用: "申万聚集" } });
  });

  it("baseline 变体（空槽位）在已切换过的 YAML 上仍是 BASELINE", () => {
    const out = applyVariantSlots(base, {});
    // 槽位是 {} 而不是缺省：引擎 `slotConfig ?? config.槽位 ?? BASELINE` 拿到 {}，逐槽落回 BASELINE
    expect(out.槽位).toEqual({});
  });

  /** 逐键合并会留下旧槽的 参数，跑出来是"新实现 + 旧参数"的第三种打法 */
  it("整槽替换：不留下被换掉那个槽的旧参数", () => {
    const out = applyVariantSlots(base, { 择时器: { 用: "五段状态机" } });
    expect((out.槽位 as any).择时器.参数).toBeUndefined();
  });

  it("不污染传入的配置 —— 同一次扫描里前一个点会脏到后一个", () => {
    applyVariantSlots(base, { 择时器: { 用: "五段状态机" } });
    expect((base.槽位 as any).择时器.用).toBe("三档阈值");
    expect((base.槽位 as any).择时器.参数).toEqual({ 阈值: 40 });
  });

  it("原配置本来没有 槽位 段时也能盖上去", () => {
    const bare = { id: "default", version: "1.0.0" } as unknown as StrategyConfig;
    const out = applyVariantSlots(bare, { 评估器: { 用: "结构位定价" } });
    expect((out.槽位 as any).评估器.用).toBe("结构位定价");
  });
});

describe("shadowVariants", () => {
  it("active 的排前面，同状态按 id", () => {
    seed([
      ["zz-late", "后来加的", "{}", "active"],
      ["retired", "已退役", "{}", "retired"],
      ["baseline", "baseline", "{}", "active"],
    ]);
    expect(shadowVariants(db).map(v => v.id)).toEqual(["baseline", "zz-late", "retired"]);
  });

  it("已退役的也列出来：历史样本按它归因，从列表里消失就没法复跑了", () => {
    seed([["old", "退役组合", "{}", "retired"]]);
    const vs = shadowVariants(db);
    expect(vs).toHaveLength(1);
    expect(vs[0].status).toBe("retired");
  });
});

/**
 * 当前生效配置用固定 fixture 注入，不读 config/strategies/default.yaml：
 * 实文件被 gitignore（含账户 id），新克隆的仓库里没有 —— 以前这一组在新克隆上整组跳过。
 * fixture 刻意带一段已切换过的 `槽位:`，用来钉住"变体不继承 YAML 槽位"。
 */
const cur = {
  id: "default", version: "1.4.0",
  槽位: { 择时器: { 用: "五段状态机" }, 评估器: { 用: "结构位定价" } },
} as unknown as StrategyConfig;
const readCur = () => ({ available: true as const, config: cur, raw: "", filePath: "fixture.yaml", validated: true });
const resolve = (t: Parameters<typeof resolveBacktestTarget>[1]) => resolveBacktestTarget(db, t, readCur);

describe("resolveBacktestTarget", () => {
  beforeEach(() => seed([["sw", "申万主线", '{"主线识别器":{"用":"申万聚集"}}', "active"]]));

  it("什么都不给 = 跑当前生效的那份", () => {
    const r = resolve({});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.target.label).toBe(`${cur.id}@${cur.version}`);
  });

  it("给变体 → 槽位盖上去，label 带上组合名（光看 strategyId 分不出变体）", () => {
    const r = resolve({ variantId: "sw" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.target.config.槽位).toEqual({ 主线识别器: { 用: "申万聚集" } });
    expect(r.target.label).toContain("申万主线");
  });

  it("baseline 变体 → 槽位为空（逐槽落回 BASELINE），不是 YAML 里切换过的那套", () => {
    seed([["baseline", "baseline", "{}", "active"]]);
    const r = resolve({ variantId: "baseline" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.target.config.槽位).toEqual({});
    // 不给变体时仍跑 YAML 当前的那套
    const plain = resolve({});
    expect(plain.ok && plain.target.config.槽位).toEqual(cur.槽位);
  });

  it("变体不存在 → 明确的拒绝，而不是静默跑 baseline", () => {
    const r = resolve({ variantId: "没有这套" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toContain("没有这套");
  });

  it("版本不存在 → 明确拒绝（快照在产生第一条预测时才落库，缺是正常的）", () => {
    const r = resolve({ strategyId: "default", strategyVersion: "9.9.9" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toContain("9.9.9");
  });

  it("槽位配置不是合法 JSON → 拒绝，不拿空配置往下跑", () => {
    seed([["broken", "坏配置", "{不是 json", "active"]]);
    const r = resolve({ variantId: "broken" });
    expect(r.ok).toBe(false);
  });
});
