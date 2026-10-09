import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  checkGraduation, runSwitchCycle, approveSwitch, rejectSwitch, rollbackSwitch,
  autoSwitchAllowed, switchStatus, incumbentOf, GRADUATION, bonferroniT, graduationBoard,
} from "@/lib/shadow/switch";
import { seedVariants, addVariant, retireVariant } from "@/lib/shadow/book";
import { writeSlotsInText, bumpPatch } from "@/lib/strategy/loader";
import { validateStrategyYaml } from "@/lib/strategy/schema";
import { canonicalJson } from "@/lib/backtest/hash";
import { defaultSlotRegistry } from "@/lib/strategy/v2";
import { makeTempDb, type TempDb } from "../pit/helpers";

const EXAMPLE = path.join(process.cwd(), "config/strategies/default.yaml.example");
const LOCK = JSON.stringify(defaultSlotRegistry.lock());

/**
 * 夹具直接复制真实的 default.yaml.example，所以版本号会随策略迭代往前走。
 *
 * 测试要守的是「每批准一次，patch 号 +1」这个行为，不是「必须是 1.3.0」——
 * 把号抄死在断言里，每次升版本都得回来改一遍，而改漏的那一个会伪装成
 * 「实现有 bug」红给你看（2026-09-27 升 1.4.0 时就踩了一次）。
 * 所以基线从文件读，期望值用生产实现自己的 bumpPatch 推。
 */
function baseVersion(): string {
  const r = validateStrategyYaml(fs.readFileSync(EXAMPLE, "utf8"), EXAMPLE);
  if (!r.ok) throw new Error(`策略样例文件校验不过：${r.issues.map(i => i.message).join("；")}`);
  return r.config.version;
}
const V0 = baseVersion();
const V1 = bumpPatch(V0), V2 = bumpPatch(V1), V3 = bumpPatch(V2);

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

/**
 * 由日期派生的确定性抖动（约 ±1.2）。
 *
 * 为什么必须有它：毕业判定的显著性 2026-09-27 起改吃**日度**序列 ——
 * 同一天成交的几笔不是独立观测。造数据时只让"笔与笔之间"有波动、
 * 每天的均值一模一样，日度方差就是 0，welch 的分母为 0，t 恒等于 0，
 * 整组测试会以一种看起来像"实现有 bug"的方式红掉。
 * 真实数据里日子与日子的差异远大于同日两笔之间的差异，fixture 必须反映这一点。
 */
function dayJitter(d: string): number {
  let h = 0;
  for (let i = 0; i < d.length; i++) h = (h * 31 + d.charCodeAt(i)) % 1000;
  return (h / 1000 - 0.5) * 2.4;
}

/** 每个变体每天两笔实盘样本：日均值 = mean + 当日抖动 × amp，笔间再 ±0.5 */
function seedLive(db: TempDb["db"], variant: string, days: string[], mean: number, lock = LOCK, amp = 1): void {
  const p = db.prepare(
    `INSERT INTO shadow_pred (id, variant_id, source, base_date, decided_on, code, account, trigger_px, size, gear, strategy_id, slot_lock, created_at)
     VALUES (?, ?, 'live', ?, ?, ?, '卫星', 10, 0.1, '中性', 'default', ?, 'x')`);
  const o = db.prepare(
    `INSERT INTO shadow_outcome (pred_id, status, entry_date, entry_px, exit_date, exit_px, exit_reason, net_pct, settled_at)
     VALUES (?, '已结算', ?, 10, ?, 10, '期满', ?, 'x')`);
  // 抖动先去均值：让这批样本的日期序列均值精确等于 mean，
  // 否则"mean = 0.02"造出来的实际是 0.02 ± 一段抽样的日子偏移，用例就没法照着数字写断言
  const js = days.map(dayJitter);
  const mj = js.reduce((a, b) => a + b, 0) / js.length;
  days.forEach((d, i) => {
    const j = (js[i] - mj) * amp;
    for (const [code, off] of [["600001", 0.5], ["600002", -0.5]] as const) {
      const id = `${d}:${variant}:live:${code}`;
      p.run(id, variant, d, d, code, lock);
      o.run(id, d, d, mean + j + off);
    }
  });
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

  it("作废（晚决策）的日子当它不存在：不算共同交易日，那天的笔数也不进已结算", () => {
    const days = weekdays(10);
    seedLive(t.db, "baseline", days, -1);
    seedLive(t.db, "pricing", days, 1);
    // pricing 第 1 天那批是 11:00 才出的卡 → 作废（结算侧 voidLateShadow 会这样改判）
    t.db.prepare(`UPDATE shadow_outcome SET status = '作废', net_pct = NULL, exit_reason = NULL
      WHERE pred_id LIKE ?`).run(`${days[0]}:pricing:%`);
    const g = checkGraduation(t.db, "pricing", "baseline", defaultSlotRegistry.lock());
    expect(g.failures.join()).toMatch(/已结算 18 笔/);
    expect(g.failures.join()).toMatch(/共同交易日 9 天/);
  });

  it("≥120 笔、≥45 天、显著更好、回撤不更深 → 毕业", () => {
    const days = weekdays(60);          // 每天两笔 → 120 笔
    seedLive(t.db, "baseline", days, -1);
    seedLive(t.db, "pricing", days, 1);
    const g = checkGraduation(t.db, "pricing", "baseline", defaultSlotRegistry.lock());
    expect(g).toMatchObject({ passed: true, days: 60, settled: 120 });
    expect(g.t!).toBeGreaterThan(2.5);
  });

  /**
   * 2026-09-27 补：这是回放置信的下最要紧的一条。
   * 旧判定只问「有没有高过在任者」，于是一个 −0.30%/笔 的挑战者
   * 能打赢 −0.63%/笔 的在任者而毕业 —— 两个都亏钱，却判成「更好」。
   */
  it("期望不为正 → 再赢在任者也不毕业（比对手亏得少不等于赚钱）", () => {
    const days = weekdays(60);
    seedLive(t.db, "baseline", days, -2);   // 在任者 −2%/笔
    seedLive(t.db, "pricing", days, -0.5);  // 挑战者 −0.5%/笔，确实赢很多
    const g = checkGraduation(t.db, "pricing", "baseline", defaultSlotRegistry.lock());
    expect(g.passed).toBe(false);
    expect(g.failures.join()).toMatch(/不为正/);
    // 相对那一条是过的，唯独绝对门槛拦住了它
    expect(g.failures.join()).not.toMatch(/期望没有高过在任者/);
  });

  it("个体效应的显著性门槛：赢了在任者但没被证实为正，仍不毕业", () => {
    const days = weekdays(60);
    seedLive(t.db, "baseline", days, -1);
    seedLive(t.db, "pricing", days, 0.02); // 勉强为正，达不到对 0 的 minAbsT
    const g = checkGraduation(t.db, "pricing", "baseline", defaultSlotRegistry.lock());
    expect(g.meanNet!).toBeGreaterThan(0);
    expect(g.passed).toBe(false);
    expect(g.failures.join()).toMatch(/对 0 检验/);
  });

  it("回撤在绝对上限之内 → 不因回撤被拦", () => {
    const days = weekdays(60);
    seedLive(t.db, "baseline", days, -1);
    seedLive(t.db, "pricing", days, 1);
    const g = checkGraduation(t.db, "pricing", "baseline", defaultSlotRegistry.lock());
    expect(g.maxDrawdown!).toBeLessThan(GRADUATION.maxDrawdown);  // 这条样本本来很小 → 能过
    expect(g.passed).toBe(true);
  });

  it("回撤超过绝对上限 → 不毕业（在任者更深也不行）", () => {
    const days = weekdays(60);
    seedLive(t.db, "baseline", days, -1);     // 在任者天天亏，累计回撤远深于挑战者
    seedLive(t.db, "pricing", days, 1);
    // 中途一笔 −40%：期望仍为正、t 仍显著，唯独回撤穿了 25% 的绝对上限
    const d = days[30], id = `${d}:pricing:live:600003`;
    t.db.prepare(
      `INSERT INTO shadow_pred (id, variant_id, source, base_date, decided_on, code, account, trigger_px, size, gear, strategy_id, slot_lock, created_at)
       VALUES (?, 'pricing', 'live', ?, ?, '600003', '卫星', 10, 0.1, '中性', 'default', ?, 'x')`).run(id, d, d, LOCK);
    t.db.prepare(
      `INSERT INTO shadow_outcome (pred_id, status, entry_date, entry_px, exit_date, exit_px, exit_reason, net_pct, settled_at)
       VALUES (?, '已结算', ?, 10, ?, 6, '止损', -40, 'x')`).run(id, d, d);
    const g = checkGraduation(t.db, "pricing", "baseline", defaultSlotRegistry.lock());
    expect(g.maxDrawdown!).toBeGreaterThan(GRADUATION.maxDrawdown);
    expect(g.incumbentMaxDrawdown!).toBeGreaterThan(g.maxDrawdown!);   // 在任者更深
    expect(g.passed).toBe(false);
    expect(g.failures).toHaveLength(1);                                 // 只有回撤这一条拦住它
    expect(g.failures[0]).toMatch(/超过绝对上限 25%/);
  });

  it("Bonferroni：多个候选同场参评时门槛抬高", () => {
    expect(bonferroniT(1)).toBe(GRADUATION.minT);
    expect(bonferroniT(9)).toBeGreaterThan(bonferroniT(2));
    expect(bonferroniT(9)).toBeGreaterThan(2.7);   // 九个候选的标准校正门槛约 2.77
  });

  /**
   * 榜单按 Bonferroni 收紧过，批准与夜间复核也必须用同一把尺子 ——
   * 否则提案时只有 1 个候选（门槛 2.5），后来候选变多，批准时仍按 2.5 放行。
   */
  describe("批准 / 复核沿用榜单的 Bonferroni 门槛", () => {
    const o = () => ({ path: file, now: "2026-02-10 22:30:00" });
    const days = weekdays(60);
    const others = () => (t.db.prepare("SELECT id FROM shadow_variant WHERE id NOT IN ('baseline', 'pricing')").all() as Array<{ id: string }>).map(r => r.id);
    const setOthers = (st: string) => t.db.prepare(`UPDATE shadow_variant SET status = ? WHERE id NOT IN ('baseline', 'pricing')`).run(st);

    /** 只剩一个挑战者时过线（t ≈ 2.66 ≥ 2.5），再把其余候选放回来 → k 变大，门槛抬到 ~2.9 */
    function proposeThenWiden(): number {
      seedLive(t.db, "baseline", days, 0);
      seedLive(t.db, "pricing", days, 0.34);
      setOthers("retired");
      const g = checkGraduation(t.db, "pricing", "baseline", defaultSlotRegistry.lock());
      expect(g.passed).toBe(true);
      const k = others().length + 1;
      expect(g.t!).toBeLessThan(bonferroniT(k));         // 夹具本身要落在 2.5 与 k 重门槛之间
      const r = runSwitchCycle(t.db, o()) as any;
      expect(r).toMatchObject({ action: "proposed", variant: "pricing" });
      setOthers("active");
      return r.id;
    }

    it("批准时候选变多 → 按 k 重门槛复核，不过线就作废", () => {
      const id = proposeThenWiden();
      expect(() => approveSwitch(t.db, id, "human", o())).toThrow(/多重检验/);
      expect(switchStatus(t.db, o()).history[0].status).toBe("stale");
      expect(readSlots().version).toBe(V0);
    });

    it("夜间复核待批提案同样按 k 重门槛", () => {
      proposeThenWiden();
      const r = runSwitchCycle(t.db, o());
      expect(r).toMatchObject({ action: "stale" });
      expect((r as any).reason).toMatch(/多重检验/);
    });
  });

  it("排序按日度期望：合格者里期望高的排前面，即使它的 t 更低", () => {
    const days = weekdays(60);
    seedLive(t.db, "baseline", days, -1);
    seedLive(t.db, "pricing", days, 1.5);                    // 期望低、波动小 → t 高
    seedLive(t.db, "cycle", days, 2, LOCK, 3);               // 期望高、波动大 → t 低
    const board = graduationBoard(t.db, "baseline", defaultSlotRegistry.lock());
    const [a, b] = board;
    expect([a.variant, b.variant]).toEqual(["cycle", "pricing"]);
    expect(a.passed && b.passed).toBe(true);
    expect(a.dailyMean!).toBeGreaterThan(b.dailyMean!);
    expect(a.t!).toBeLessThan(b.t!);                          // 按 t 排就会反过来
    expect(board.slice(2).every(g => !g.passed)).toBe(true);
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
  const days = weekdays(60);
  const o = () => ({ path: file, now: "2026-02-10 22:30:00" });

  it("过线 → 提案待批并通知；批准 → 写槽位、升版本，在任者变成挑战者", () => {
    seedLive(t.db, "baseline", days, -1);
    seedLive(t.db, "pricing", days, 1);
    const r = runSwitchCycle(t.db, o());
    expect(r).toMatchObject({ action: "proposed", variant: "pricing" });
    const n = t.db.prepare("SELECT title, body FROM notification WHERE kind = 'shadow_switch'").all() as any[];
    expect(n[0].title).toMatch(/待你批准/);
    expect(readSlots().version).toBe(V0);                    // 没批之前文件不动

    const a = approveSwitch(t.db, (r as any).id, "human", o());
    expect(a).toMatchObject({ status: "applied", decidedBy: "human", fromVersion: V0, toVersion: V1 });
    expect(readSlots()).toEqual({ slots: { 评估器: { 用: "结构位定价" } }, version: V1 });
    expect(incumbentOf(t.db, canonicalJson(readSlots().slots))).toBe("pricing");
    // 旧版本原文留了快照
    expect(t.db.prepare(`SELECT COUNT(*) n FROM strategy WHERE id = 'default' AND version = '${V0}'`).get()).toEqual({ n: 1 });
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
    expect(switchStatus(t.db, o()).history[0]).toMatchObject({ decidedBy: "auto", toVersion: V3 });
  });

  it("回滚：恢复上一套槽位、版本照样往前升、自动切换暂停、被回滚的不立刻卷土重来", () => {
    seedLive(t.db, "baseline", days, -1);
    seedLive(t.db, "pricing", days, 1);
    const r = runSwitchCycle(t.db, o()) as any;
    approveSwitch(t.db, r.id, "human", o());
    const rb = rollbackSwitch(t.db, { ...o(), note: "看不顺眼" });
    expect(rb).toMatchObject({ kind: "rollback", fromVariant: "pricing", toVariant: "baseline", toVersion: V2, reverts: r.id });
    expect(readSlots()).toEqual({ slots: {}, version: V2 });
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
