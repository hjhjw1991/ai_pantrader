import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { applyVariantSlots, resolveBacktestTarget } from "@/lib/ui/adapters/engines";
import { readStrategyConfig } from "@/lib/ui/adapters/strategy";
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

  it("不动变体没提的槽 —— 变体只声明它要换的那几个", () => {
    const out = applyVariantSlots(base, { 主线识别器: { 用: "申万聚集" } });
    expect((out.槽位 as any).评估器.用).toBe("可配权重打分");
    expect((out.槽位 as any).择时器.用).toBe("三档阈值");
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
 * 下面几条要读真实的 config/strategies/default.yaml。
 * 实文件被 gitignore（含账户 id），新克隆的仓库里没有 —— 没有就跳过，
 * 别让"环境里缺一份个人配置"变成一条红测试。
 */
const cfg = readStrategyConfig();
/** 在闭包里用要提前收窄好：条件表达式不会把收窄带进回调作用域 */
const cur = cfg.available ? cfg.config : null;
const maybe = cfg.available ? describe : describe.skip;

maybe("resolveBacktestTarget", () => {
  beforeEach(() => seed([["sw", "申万主线", '{"主线识别器":{"用":"申万聚集"}}', "active"]]));

  it("什么都不给 = 跑当前生效的那份", () => {
    const r = resolveBacktestTarget(db, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.target.label).toBe(`${cur!.id}@${cur!.version}`);
  });

  it("给变体 → 槽位盖上去，label 带上组合名（光看 strategyId 分不出变体）", () => {
    const r = resolveBacktestTarget(db, { variantId: "sw" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect((r.target.config.槽位 as any).主线识别器.用).toBe("申万聚集");
    expect(r.target.label).toContain("申万主线");
  });

  it("变体不存在 → 明确的拒绝，而不是静默跑 baseline", () => {
    const r = resolveBacktestTarget(db, { variantId: "没有这套" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toContain("没有这套");
  });

  it("版本不存在 → 明确拒绝（快照在产生第一条预测时才落库，缺是正常的）", () => {
    const r = resolveBacktestTarget(db, { strategyId: "default", strategyVersion: "9.9.9" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toContain("9.9.9");
  });

  it("槽位配置不是合法 JSON → 拒绝，不拿空配置往下跑", () => {
    seed([["broken", "坏配置", "{不是 json", "active"]]);
    const r = resolveBacktestTarget(db, { variantId: "broken" });
    expect(r.ok).toBe(false);
  });
});
