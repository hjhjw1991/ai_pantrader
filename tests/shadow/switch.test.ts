import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  checkGraduation, runSwitchCycle, approveSwitch, rejectSwitch, rollbackSwitch,
  autoSwitchAllowed, switchStatus, incumbentOf,
} from "@/lib/shadow/switch";
import { seedVariants, addVariant, retireVariant } from "@/lib/shadow/book";
import { writeSlotsInText, bumpPatch } from "@/lib/strategy/loader";
import { validateStrategyYaml } from "@/lib/strategy/schema";
import { canonicalJson } from "@/lib/backtest/hash";
import { defaultSlotRegistry } from "@/lib/strategy/v2";
import { makeTempDb, type TempDb } from "../pit/helpers";

const EXAMPLE = path.join(process.cwd(), "config/strategies/default.yaml.example");
const LOCK = JSON.stringify(defaultSlotRegistry.lock());

/** 从 2026-01-05 起的 n 个工作日 */
function weekdays(n: number): string[] {
  const out: string[] = [];
  const d = new Date("2026-01-05T00:00:00Z");
  while (out.length < n) {
    if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

/** 每个变体每天两笔实盘样本：均值 mean（百分点），±0.5 的波动 */
function seedLive(db: TempDb["db"], variant: string, days: string[], mean: number, lock = LOCK): void {
  const p = db.prepare(
    `INSERT INTO shadow_pred (id, variant_id, source, base_date, decided_on, code, account, trigger_px, size, gear, strategy_id, slot_lock, created_at)
     VALUES (?, ?, 'live', ?, ?, ?, '卫星', 10, 0.1, '中性', 'default', ?, 'x')`);
  const o = db.prepare(
    `INSERT INTO shadow_outcome (pred_id, status, entry_date, entry_px, exit_date, exit_px, exit_reason, net_pct, settled_at)
     VALUES (?, '已结算', ?, 10, ?, 10, '期满', ?, 'x')`);
  for (const d of days) {
    for (const [code, net] of [["600001", mean + 0.5], ["600002", mean - 0.5]] as const) {
      const id = `${d}:${variant}:live:${code}`;
      p.run(id, variant, d, d, code, lock);
      o.run(id, d, d, net);
    }
  }
}

let t: TempDb;
let dir: string;
let file: string;
beforeEach(() => {
  t = makeTempDb();
  seedVariants(t.db);
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "pt-switch-"));
  file = path.join(dir, "default.yaml");
  fs.copyFileSync(EXAMPLE, file);
});
afterEach(() => { t.close(); fs.rmSync(dir, { recursive: true, force: true }); });

const readSlots = () => {
  const r = validateStrategyYaml(fs.readFileSync(file, "utf8"), file);
  if (!r.ok) throw new Error("策略文件校验不过");
  return { slots: r.config.槽位 ?? {}, version: r.config.version };
};

describe("writeSlotsInText / bumpPatch", () => {
  const src = "id: x\nversion: 1.0.0\n\n槽位:\n  # 旧注释\n  评估器: {\"用\":\"结构位定价\"}\n\n组合风控:\n  a: 1\n";

  it("有段就整段换，下一段原样不动", () => {
    const out = writeSlotsInText(src, { 择时器: { 用: "五段状态机" } }, "新");
    expect(out).toContain('  择时器: {"用":"五段状态机"}');
    expect(out).not.toContain("结构位定价");
    expect(out).not.toContain("旧注释");
    expect(out.endsWith("\n\n组合风控:\n  a: 1\n")).toBe(true);
  });

  it("空对象 = 删掉整段，回到 baseline", () => {
    const out = writeSlotsInText(src, {}, "新");
    expect(out).not.toContain("槽位");
    expect(out).toContain("组合风控:\n  a: 1");
    expect(out).not.toContain("\n\n\n");
  });

  it("没有段就追加到末尾；真实策略文件写完仍能通过校验", () => {
    const raw = fs.readFileSync(EXAMPLE, "utf8");
    const out = writeSlotsInText(raw, { 评估器: { 用: "结构位定价" } }, "测试");
    expect(out.startsWith(raw)).toBe(true);
    const r = validateStrategyYaml(out, "x");
    expect(r.ok && r.config.槽位).toEqual({ 评估器: { 用: "结构位定价" } });
  });

  it("bumpPatch 只认 x.y.z", () => {
    expect(bumpPatch("1.3.9")).toBe("1.3.10");
    expect(() => bumpPatch("v1")).toThrow(/x\.y\.z/);
  });
});

describe("毕业判定", () => {
  it("样本不够不毕业，并说清还差什么", () => {
    const days = weekdays(10);
    seedLive(t.db, "baseline", days, -1);
    seedLive(t.db, "pricing", days, 1);
    const g = checkGraduation(t.db, "pricing", "baseline", defaultSlotRegistry.lock());
    expect(g.passed).toBe(false);
    expect(g.failures.join()).toMatch(/已结算 20 笔/);
    expect(g.failures.join()).toMatch(/共同交易日 10 天/);
  });

  it("≥30 笔、≥20 天、显著更好、回撤不更深 → 毕业", () => {
    const days = weekdays(20);
    seedLive(t.db, "baseline", days, -1);
    seedLive(t.db, "pricing", days, 1);
    const g = checkGraduation(t.db, "pricing", "baseline", defaultSlotRegistry.lock());
    expect(g).toMatchObject({ passed: true, days: 20, settled: 40 });
    expect(g.t!).toBeGreaterThan(2);
  });

  it("只比共同的日子：挑战者多出来的日子不算", () => {
    const days = weekdays(30);
    seedLive(t.db, "baseline", days.slice(15), -1);
    seedLive(t.db, "pricing", days, 1);
    expect(checkGraduation(t.db, "pricing", "baseline", defaultSlotRegistry.lock()).days).toBe(15);
  });

  it("槽实现换了版本，旧样本不算", () => {
    const days = weekdays(20);
    seedLive(t.db, "baseline", days, -1);
    seedLive(t.db, "pricing", days, 1, JSON.stringify({ ...defaultSlotRegistry.lock(), "评估器:结构位定价": "0.9.0" }));
    expect(checkGraduation(t.db, "pricing", "baseline", defaultSlotRegistry.lock()).days).toBe(0);
  });
});

describe("切换流程", () => {
  const days = weekdays(20);
  const o = () => ({ path: file, now: "2026-02-10 22:30:00" });

  it("过线 → 提案待批并通知；批准 → 写槽位、升版本，在任者变成挑战者", () => {
    seedLive(t.db, "baseline", days, -1);
    seedLive(t.db, "pricing", days, 1);
    const r = runSwitchCycle(t.db, o());
    expect(r).toMatchObject({ action: "proposed", variant: "pricing" });
    const n = t.db.prepare("SELECT title, body FROM notification WHERE kind = 'shadow_switch'").all() as any[];
    expect(n[0].title).toMatch(/待你批准/);
    expect(readSlots().version).toBe("1.3.0");               // 没批之前文件不动

    const a = approveSwitch(t.db, (r as any).id, "human", o());
    expect(a).toMatchObject({ status: "applied", decidedBy: "human", fromVersion: "1.3.0", toVersion: "1.3.1" });
    expect(readSlots()).toEqual({ slots: { 评估器: { 用: "结构位定价" } }, version: "1.3.1" });
    expect(incumbentOf(t.db, canonicalJson(readSlots().slots))).toBe("pricing");
    // 旧版本原文留了快照
    expect(t.db.prepare("SELECT COUNT(*) n FROM strategy WHERE id = 'default' AND version = '1.3.0'").get()).toEqual({ n: 1 });
    // 有待批时不重复提案；批过之后按新在任者重新比 —— pricing 自己不再参评
    expect(runSwitchCycle(t.db, o()).action).toBe("none");
  });

  it("人批满 2 次之后，第 3 次自动切换", () => {
    seedLive(t.db, "baseline", days, -3);
    seedLive(t.db, "pricing", days, -1);
    seedLive(t.db, "cycle", days, 1);
    seedLive(t.db, "cycle+pricing", days, 3);
    // 第一轮：t 最高的是 cycle+pricing 对 baseline —— 一次只换一套，取最好的
    const r1 = runSwitchCycle(t.db, o()) as any;
    expect(r1.variant).toBe("cycle+pricing");
    rejectSwitch(t.db, r1.id, "先不要", "2026-02-10 22:31:00");
    // 被否决的进冷却；下一个是 cycle
    const r2 = runSwitchCycle(t.db, o()) as any;
    expect(r2).toMatchObject({ action: "proposed", variant: "cycle" });
    approveSwitch(t.db, r2.id, "human", o());
    expect(autoSwitchAllowed(t.db)).toBe(false);
    // cycle+pricing 还在冷却期（否决之后没有新样本），不会挡路
    addVariant(t.db, { id: "hot", name: "高潮进攻", slots: { 择时器: { 用: "五段状态机", 参数: { 阶段档位: { 高潮: "进攻" } } } }, note: "" });
    seedLive(t.db, "hot", days, 5);
    const r3 = runSwitchCycle(t.db, o()) as any;
    expect(r3).toMatchObject({ action: "proposed", variant: "hot" });
    approveSwitch(t.db, r3.id, "human", o());
    expect(autoSwitchAllowed(t.db)).toBe(true);

    addVariant(t.db, { id: "hot2", name: "高潮进攻+结构位", slots: { 择时器: { 用: "五段状态机", 参数: { 阶段档位: { 高潮: "进攻" } } }, 评估器: { 用: "结构位定价" } }, note: "" });
    seedLive(t.db, "hot2", days, 7);
    const r4 = runSwitchCycle(t.db, o());
    expect(r4).toMatchObject({ action: "applied", variant: "hot2" });
    expect(switchStatus(t.db, o()).history[0]).toMatchObject({ decidedBy: "auto", toVersion: "1.3.3" });
  });

  it("回滚：恢复上一套槽位、版本照样往前升、自动切换暂停、被回滚的不立刻卷土重来", () => {
    seedLive(t.db, "baseline", days, -1);
    seedLive(t.db, "pricing", days, 1);
    const r = runSwitchCycle(t.db, o()) as any;
    approveSwitch(t.db, r.id, "human", o());
    const rb = rollbackSwitch(t.db, { ...o(), note: "看不顺眼" });
    expect(rb).toMatchObject({ kind: "rollback", fromVariant: "pricing", toVariant: "baseline", toVersion: "1.3.2", reverts: r.id });
    expect(readSlots()).toEqual({ slots: {}, version: "1.3.2" });
    expect(fs.readFileSync(file, "utf8")).not.toMatch(/^槽位/m);
    expect(autoSwitchAllowed(t.db)).toBe(false);
    expect(runSwitchCycle(t.db, o()).action).toBe("none");
    expect(() => rollbackSwitch(t.db, o())).toThrow(/没有可回滚/);
  });

  it("等批期间文件被手改 → 提案作废，不覆盖人的改动；回滚同理", () => {
    seedLive(t.db, "baseline", days, -1);
    seedLive(t.db, "pricing", days, 1);
    const r = runSwitchCycle(t.db, o()) as any;
    fs.writeFileSync(file, writeSlotsInText(fs.readFileSync(file, "utf8"), { 择时器: { 用: "五段状态机" } }, "手改"));
    expect(() => approveSwitch(t.db, r.id, "human", o())).toThrow(/作废/);
    expect(switchStatus(t.db, o()).history[0].status).toBe("stale");
    expect(readSlots().slots).toEqual({ 择时器: { 用: "五段状态机" } });
  });

  it("槽位被手改成没登记的组合 → 没有在任者，不提案", () => {
    fs.writeFileSync(file, writeSlotsInText(fs.readFileSync(file, "utf8"), { 离场器: { 用: "账户纪律" } }, "手改"));
    expect(runSwitchCycle(t.db, o())).toMatchObject({ action: "none" });
  });
});

describe("变体增删", () => {
  it("槽名没注册的组合登记时就拦下；id 不能复用", () => {
    expect(() => addVariant(t.db, { id: "bad", name: "x", slots: { 评估器: { 用: "不存在" } } as any, note: "" })).toThrow(/槽位未注册/);
    expect(() => addVariant(t.db, { id: "pricing", name: "x", slots: {}, note: "" })).toThrow(/已存在/);
  });

  it("baseline 与在任组合不能退役；其余退役后不再参评", () => {
    expect(() => retireVariant(t.db, "baseline")).toThrow(/对照组/);
    expect(() => retireVariant(t.db, "pricing", "pricing")).toThrow(/正式策略/);
    retireVariant(t.db, "pricing");
    expect(switchStatus(t.db, { path: file }).board.map(g => g.variant)).not.toContain("pricing");
  });
});
