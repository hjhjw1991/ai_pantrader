/**
 * 影子盘跑离场器（用户 2026-10-09 选定）。
 *
 *   - baseline 对拍：账户纪律中和后不出手，结算与冻结的旧实现（25d8993）逐字段一致 ——
 *     手写分支 + 随机路径两套，钩子是**真的调了账户纪律槽**，不是短路
 *   - 游资纪律：炸板未封 / 破 MA5 在 baseline 拿到期满的地方次日开盘走
 *   - r-exit-hard（只换离场器）在库里结出与 baseline 不同的结果，exit_slot 落表
 *   - 减仓：按卖出比例加权平均离场价；一笔只减一次
 *   - 无前视：槽看到的日线不晚于判定日；判定日之后的 K 线怎么改都不影响结果
 *   - 029 迁移；重结算幂等；统计不混口径
 *   - 耗时：几百笔走离场器的结算
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { DailyBar, EntryType, ExitSlot, SecurityRow } from "@/lib/contracts";
import { settleShadow, type ShadowPlan } from "@/lib/shadow/settle";
import { resolveExitSlot, slotExitHook, memoryView, legacyExitKey, type ResolvedExit } from "@/lib/shadow/exit-slot";
import { settleShadowPending, runShadowDay, seedVariants, addVariant, staleExitVariants, resettleShadow } from "@/lib/shadow/book";
import { loadTrades } from "@/lib/shadow/report";
import { settleShadowLegacy } from "./fixtures/settle-legacy";
import { makeTempDb, insDaily, insSecurity, insCalendar, type TempDb } from "../pit/helpers";
import { config } from "../strategy/helpers";

/* ------------------------------- 公用 ------------------------------- */

/** 2026-06-01 起的工作日（够用即可，影子盘结算只认 K 线的先后） */
const DATES: string[] = (() => {
  const out: string[] = [];
  const d = new Date(Date.UTC(2026, 5, 1));
  while (out.length < 80) {
    const w = d.getUTCDay();
    if (w !== 0 && w !== 6) out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
})();

const CODE = "600001";
const SEC: SecurityRow = { code: CODE, name: CODE, listDate: "2010-01-01", delistDate: null, board: "主板", isStHistory: [] };
const COST = { slippage: 0.001, feeRate: 0.0005 };
const OPTS = { horizon: 5, ...COST };

type OHLC = [number, number, number, number];
/** 从 DATES[from] 起连续造 K 线 */
const mk = (from: number, px: OHLC[], adj: number[] = []): DailyBar[] =>
  px.map(([o, h, l, c], i) => ({ code: CODE, date: DATES[from + i], o, h, l, c, vol: 1e6, amount: 1e7, adjFactor: adj[i] ?? 1 }));
const flat = (from: number, n: number, c: number): DailyBar[] => mk(from, Array.from({ length: n }, () => [c, c, c, c] as OHLC));

const ACCOUNT_EXIT = resolveExitSlot({});
const hmExit = (参数: Record<string, unknown>) => resolveExitSlot({ 离场器: { 用: "游资纪律", 参数 } });

/** prior = 基准日及之前（最后一根是基准日），path = 成交日起 */
function run(exit: ResolvedExit | null, plan: ShadowPlan, prior: DailyBar[], path: DailyBar[], o: Record<string, unknown> = {}) {
  const hook = exit === null ? undefined
    : slotExitHook({ exit, code: CODE, account: "卫星", raw: [...prior, ...path], bars: path, security: SEC });
  return settleShadow(plan, path, { ...OPTS, ...o }, hook);
}

/* ------------------------------- baseline 对拍 ------------------------------- */

describe("baseline 对拍：账户纪律中和后不出手，与旧结算逐字段一致", () => {
  const prior = flat(0, 30, 10);
  const P = (over: Partial<ShadowPlan> = {}): ShadowPlan => ({ triggerPx: 10, stopPx: 9.5, targetPx: 11, ...over });
  const cases: Array<{ name: string; plan: ShadowPlan; path: DailyBar[]; o?: Record<string, unknown> }> = [
    { name: "盘中止损", plan: P(), path: mk(30, [[10, 10.2, 9.9, 10.1], [10, 10.1, 9.4, 9.6]]) },
    { name: "盘中目标", plan: P(), path: mk(30, [[10, 10.2, 9.9, 10.1], [10.2, 11.3, 10.1, 11]]) },
    { name: "跳空低开穿止损", plan: P(), path: mk(30, [[10, 10.2, 9.9, 10.1], [9.2, 9.3, 9.0, 9.1]]) },
    { name: "跳空高开越目标", plan: P(), path: mk(30, [[10, 10.2, 9.9, 10.1], [11.5, 11.8, 11.3, 11.6]]) },
    { name: "同日两线都碰按止损", plan: P(), path: mk(30, [[10, 10.2, 9.9, 10.1], [10.1, 11.2, 9.3, 10]]) },
    { name: "期满", plan: P(), path: mk(30, [[10, 10.2, 9.9, 10.1], [10.1, 10.3, 9.8, 10.2], [10.2, 10.4, 10, 10.3], [10.3, 10.5, 10.1, 10.4], [10.4, 10.6, 10.2, 10.5]]) },
    { name: "一字跌停顺延止损", plan: P(), path: mk(30, [[10, 10.2, 9.9, 10.1], [9.09, 9.09, 9.09, 9.09], [8.9, 9.2, 8.8, 9]]) },
    { name: "期满日一字跌停次日开盘走", plan: P({ stopPx: 5 }), path: mk(30, [[10, 10.2, 9.9, 10], [10, 10.1, 9.9, 10], [10, 10.1, 9.9, 10], [10, 10.1, 9.9, 10], [9, 9, 9, 9], [8.5, 8.8, 8.3, 8.6]]) },
    // 账户纪律原样跑的话：收盘浮亏 −12% 会判清仓、浮盈 +8% 会判止盈 —— 中和之后都不该出手
    { name: "无止损深跌（账户纪律 −10% 被中和）", plan: P({ stopPx: null, targetPx: null }), path: mk(30, [[10, 10.2, 9.9, 10], [9, 9.1, 8.7, 8.8], [8.8, 8.9, 8.6, 8.7], [8.7, 8.9, 8.6, 8.8], [8.8, 9, 8.7, 8.9]]) },
    { name: "无目标大涨（止盈档被中和）", plan: P({ targetPx: null }), path: mk(30, [[10, 10.2, 9.9, 10.1], [10.5, 10.9, 10.4, 10.8], [10.8, 11, 10.7, 10.9], [10.9, 11.1, 10.8, 11], [11, 11.2, 10.9, 11.1]]) },
    { name: "突破成交", plan: P({ triggerPx: 10.5, stopPx: 10, entryType: "突破" }), path: mk(30, [[10.2, 10.8, 10.1, 10.6], [10.6, 10.7, 10.5, 10.6], [10.6, 10.7, 10.5, 10.6], [10.6, 10.7, 10.5, 10.6], [10.6, 10.7, 10.5, 10.6]]) },
    { name: "突破一字涨停买不进", plan: P({ triggerPx: 10.5, entryType: "突破" }), path: mk(30, [[11, 11, 11, 11]]) },
    { name: "低吸未触发", plan: P({ triggerPx: 9.5 }), path: mk(30, [[10, 10.2, 9.8, 10]]) },
    { name: "持有期没走完 → 待定", plan: P(), path: mk(30, [[10, 10.2, 9.9, 10.1], [10.1, 10.3, 9.8, 10.2]]) },
    { name: "持有期内除权（10 送 10）", plan: P(), path: mk(30, [[10, 10.2, 9.9, 10.1], [5.05, 5.2, 5, 5.1], [5.1, 5.2, 5, 5.1], [5.1, 5.2, 5, 5.1], [5.1, 5.2, 5, 5.1]], [1, 2, 2, 2, 2]) },
    { name: "基准日复权因子不同", plan: P(), path: mk(30, [[10, 10.2, 9.9, 10.1], [10.1, 10.3, 9.8, 10.2], [10.2, 10.4, 10, 10.3], [10.3, 10.5, 10.1, 10.4], [10.4, 10.6, 10.2, 10.5]]), o: { baseAdjFactor: 1.02 } },
  ];

  for (const c of cases) {
    it(c.name, () => {
      const legacy = settleShadowLegacy(c.plan, c.path, { ...OPTS, ...(c.o ?? {}) });
      expect(run(null, c.plan, prior, c.path, c.o)).toEqual(legacy);
      expect(run(ACCOUNT_EXIT, c.plan, prior, c.path, c.o)).toEqual(legacy);
    });
  }

  it("随机路径 600 条：不给钩子、给账户纪律钩子，都与旧结算逐字段一致", () => {
    let seed = 20261009;
    const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
    let settled = 0;
    for (let n = 0; n < 600; n++) {
      const pre: DailyBar[] = [];
      let c = 10;
      for (let i = 0; i < 30; i++) { const o = c; c = +(c * (1 + (rnd() - 0.5) * 0.06)).toFixed(2); pre.push(...mk(i, [[o, Math.max(o, c) * 1.01, Math.min(o, c) * 0.99, c]])); }
      const path: DailyBar[] = [];
      let adj = 1;
      const len = 1 + Math.floor(rnd() * 9);
      for (let i = 0; i < len; i++) {
        const prev = c;
        if (rnd() < 0.08) { c = +(prev * 0.9).toFixed(2); path.push(...mk(30 + i, [[c, c, c, c]], [adj])); continue; }
        if (rnd() < 0.05) adj *= 1.1;
        const o = +(prev * (1 + (rnd() - 0.5) * 0.08)).toFixed(2);
        c = +(o * (1 + (rnd() - 0.5) * 0.1)).toFixed(2);
        path.push(...mk(30 + i, [[o, +(Math.max(o, c) * (1 + rnd() * 0.03)).toFixed(2), +(Math.min(o, c) * (1 - rnd() * 0.03)).toFixed(2), c]], [adj]));
      }
      const trig = +(pre[29].c * (1 + (rnd() - 0.6) * 0.08)).toFixed(2);
      const entryType: EntryType = rnd() < 0.3 ? "突破" : "低吸";
      const plan: ShadowPlan = {
        triggerPx: trig, entryType,
        stopPx: rnd() < 0.2 ? null : +(trig * (0.88 + rnd() * 0.08)).toFixed(2),
        targetPx: rnd() < 0.5 ? null : +(trig * (1.04 + rnd() * 0.08)).toFixed(2),
      };
      const legacy = settleShadowLegacy(plan, path, OPTS);
      expect(run(null, plan, pre, path)).toEqual(legacy);
      expect(run(ACCOUNT_EXIT, plan, pre, path)).toEqual(legacy);
      if (legacy.status === "已结算") settled++;
    }
    expect(settled).toBeGreaterThan(150);   // 样本里真有足够多走完全程的
  });

  it("账户纪律被认作与旧结算等价（结算侧直接不问）；游资纪律 / 路径纪律不是", () => {
    expect(ACCOUNT_EXIT.legacyEquivalent).toBe(true);
    expect(ACCOUNT_EXIT.key).toBe("离场器:账户纪律@1.0.0");
    expect(legacyExitKey()).toBe(ACCOUNT_EXIT.key);
    expect(hmExit({}).legacyEquivalent).toBe(false);
    expect(resolveExitSlot({ 离场器: { 用: "路径纪律" } }).legacyEquivalent).toBe(false);
    expect(() => resolveExitSlot({ 离场器: { 用: "不存在" } })).toThrow(/离场器未注册/);
  });
});

/* ------------------------------- 游资纪律 ------------------------------- */

describe("游资纪律：baseline 拿到期满的地方，它次日开盘走", () => {
  it("炸板未封（打板成交日摸板没封住）→ 次日开盘清仓", () => {
    const prior = flat(0, 30, 10);
    // 打板：触发价 = 涨停价 11，突破单；成交日摸到 11 收 10.6（炸板），之后在止损上方横盘
    const plan: ShadowPlan = { triggerPx: 11, stopPx: 10.45, targetPx: null, entryType: "突破" };
    const path = mk(30, [[10.5, 11, 10.5, 10.6], [10.7, 10.9, 10.6, 10.8], [10.8, 10.9, 10.7, 10.8], [10.8, 10.9, 10.7, 10.8], [10.8, 10.9, 10.7, 10.8]]);
    const base = run(ACCOUNT_EXIT, plan, prior, path);
    expect(base).toMatchObject({ status: "已结算", exitReason: "期满", exitPx: 10.8, exitDate: DATES[34] });
    const hm = run(hmExit({ 止损: -0.05, 破线: "MA5", 炸板走: true }), plan, prior, path);
    expect(hm).toMatchObject({ status: "已结算", entryPx: 11, exitReason: "离场器", exitPx: 10.7, exitDate: DATES[31] });
    expect(hm.note).toContain("炸板未封");
    expect(hm.note).toContain(`${DATES[30]} 收盘`);
    // 关掉炸板走就回到 baseline
    expect(run(hmExit({ 止损: -0.05, 破线: null, 炸板走: false }), plan, prior, path)).toEqual(base);
  });

  it("收盘跌破 MA5 → 次日开盘清仓（止损线远在下方，baseline 拿到期满）", () => {
    const prior = mk(25, [[9.6, 9.6, 9.6, 9.6], [9.8, 9.8, 9.8, 9.8], [10, 10, 10, 10], [10.2, 10.2, 10.2, 10.2], [10.4, 10.4, 10.4, 10.4]]);
    const plan: ShadowPlan = { triggerPx: 10.1, stopPx: 9.3, targetPx: null };
    const path = mk(30, [[10.3, 10.4, 10, 10.3], [10.3, 10.35, 9.95, 10], [10.05, 10.2, 9.9, 10.1], [10.1, 10.2, 10, 10.1], [10.1, 10.2, 10, 10.1]]);
    expect(run(ACCOUNT_EXIT, plan, prior, path)).toMatchObject({ exitReason: "期满", exitDate: DATES[34] });
    const hm = run(hmExit({ 止损: -0.08, 破线: "MA5" }), plan, prior, path);
    expect(hm).toMatchObject({ exitReason: "离场器", exitPx: 10.05, exitDate: DATES[32] });
    expect(hm.note).toContain("跌破MA5");
  });

  it("离场器的单遇一字跌停：顺延到下一个能卖的交易日开盘", () => {
    const prior = flat(0, 30, 10);
    const plan: ShadowPlan = { triggerPx: 11, stopPx: 5, targetPx: null, entryType: "突破" };
    const path = mk(30, [[10.5, 11, 10.5, 10.6], [9.54, 9.54, 9.54, 9.54], [9.3, 9.6, 9.2, 9.4], [9.4, 9.5, 9.3, 9.4], [9.4, 9.5, 9.3, 9.4]]);
    const hm = run(hmExit({ 炸板走: true, 破线: null, 止损: -0.5 }), plan, prior, path);
    expect(hm).toMatchObject({ exitReason: "离场器", exitPx: 9.3, exitDate: DATES[32] });
    expect(hm.note).toContain("一字跌停，离场器的单顺延");
  });
});

/* ------------------------------- 减仓 ------------------------------- */

describe("减仓：按卖出比例加权平均离场价", () => {
  /** 测试用离场器：在指定日子收盘后判减半 / 清仓 */
  const fake = (plan: Record<string, "减仓" | "清仓">): ResolvedExit => {
    const slot: ExitSlot = {
      kind: "离场器", name: "测试", version: "0.0.1",
      decide: (ctx, _p, pos) => ({
        code: pos.code, name: pos.code, account: pos.account, triggerPx: null, stopPx: null,
        passedFilters: [], factors: [], score: 0,
        action: plan[ctx.date] ?? "持有", size: plan[ctx.date] === "减仓" ? 0.5 : plan[ctx.date] === "清仓" ? 0 : 1,
        thesis: `底；测试：${plan[ctx.date] ?? "持有"}`,
      }),
    };
    return { slot, params: {}, key: "离场器:测试@0.0.1", legacyEquivalent: false };
  };
  const prior = flat(0, 30, 10);
  const plan: ShadowPlan = { triggerPx: 10, stopPx: 9, targetPx: 11 };

  it("第 2 天收盘减半 → 第 3 天开盘卖一半，余下当天碰目标", () => {
    const path = mk(30, [[10, 10.1, 9.9, 10], [10, 10.3, 9.9, 10.2], [10.4, 11.2, 10.3, 10.9]]);
    const r = run(fake({ [DATES[31]]: "减仓" }), plan, prior, path);
    const avg = 0.5 * 10.4 + 0.5 * 11;
    expect(r).toMatchObject({ status: "已结算", exitReason: "目标", exitDate: DATES[32] });
    expect(r.exitPx).toBeCloseTo(avg, 6);
    expect(r.grossPct).toBeCloseTo((avg / 10 - 1) * 100, 6);
    expect(r.netPct).toBeCloseTo(((avg * (1 - COST.slippage) * (1 - COST.feeRate)) / (10 * (1 + COST.slippage) * (1 + COST.feeRate)) - 1) * 100, 6);
    expect(r.note).toContain("减仓至 50%");
  });

  it("天天判减半也只减一次；之后的清仓卖掉余下的", () => {
    const path = mk(30, [[10, 10.1, 9.9, 10], [10, 10.3, 9.9, 10.2], [10.4, 10.6, 10.3, 10.5], [10.5, 10.7, 10.4, 10.6], [10.6, 10.8, 10.5, 10.7]]);
    const every = Object.fromEntries(DATES.slice(30, 35).map(d => [d, "减仓" as const]));
    const r = run(fake(every), plan, prior, path);
    expect(r).toMatchObject({ exitReason: "期满", exitDate: DATES[34] });
    // 成交日收盘第一次判减半 → 第 2 天开盘 10 卖一半；之后天天再判也不再减，余下第 5 天收盘期满
    expect(r.exitPx).toBeCloseTo(0.5 * 10 + 0.5 * 10.7, 6);
  });

  it("清仓接在减仓之后", () => {
    const path = mk(30, [[10, 10.1, 9.9, 10], [10.1, 10.3, 9.9, 10.2], [10.4, 10.6, 10.3, 10.5], [10.6, 10.7, 10.4, 10.6], [10.6, 10.8, 10.5, 10.7]]);
    const r = run(fake({ [DATES[30]]: "减仓", [DATES[32]]: "清仓" }), plan, prior, path);
    expect(r).toMatchObject({ exitReason: "离场器", exitDate: DATES[33] });
    expect(r.exitPx).toBeCloseTo(0.5 * 10.1 + 0.5 * 10.6, 6);
  });
});

/* ------------------------------- 无前视 ------------------------------- */

describe("无前视", () => {
  it("槽在第 i 天收盘看到的日线不晚于第 i 天；ctx.date 就是第 i 天", () => {
    const seen: Array<{ date: string; last: string }> = [];
    const spy: ResolvedExit = {
      slot: {
        kind: "离场器", name: "探针", version: "0.0.1",
        decide: (ctx, _p, pos) => {
          const bars = ctx.view.dailyBars(pos.code, 999);
          seen.push({ date: ctx.date, last: bars[bars.length - 1].date });
          expect(ctx.view.quote(pos.code)).toBeNull();
          return { code: pos.code, name: pos.code, account: pos.account, triggerPx: null, stopPx: null, passedFilters: [], factors: [], score: 0, action: "持有", size: 1, thesis: "探针" };
        },
      },
      params: {}, key: "离场器:探针@0.0.1", legacyEquivalent: false,
    };
    const prior = flat(0, 30, 10);
    const path = mk(30, [[10, 10.1, 9.9, 10], [10, 10.1, 9.9, 10], [10, 10.1, 9.9, 10], [10, 10.1, 9.9, 10], [10, 10.1, 9.9, 10], [10, 10.1, 9.9, 10]]);
    run(spy, { triggerPx: 10, stopPx: 9, targetPx: null }, prior, path);
    // 成交日 ~ 第 4 天收盘各问一次；第 5 天（期满日）不问
    expect(seen.map(s => s.date)).toEqual(DATES.slice(30, 34));
    for (const s of seen) expect(s.last).toBe(s.date);
  });

  it("判定日之后的 K 线怎么改都不影响结果（除了执行那天的开盘价）", () => {
    const prior = flat(0, 30, 10);
    const plan: ShadowPlan = { triggerPx: 11, stopPx: 10.45, targetPx: null, entryType: "突破" };
    const path = mk(30, [[10.5, 11, 10.5, 10.6], [10.7, 10.9, 10.6, 10.8], [10.8, 10.9, 10.7, 10.8], [10.8, 10.9, 10.7, 10.8], [10.8, 10.9, 10.7, 10.8]]);
    const ex = hmExit({ 止损: -0.05, 破线: "MA5", 炸板走: true });
    const a = run(ex, plan, prior, path);
    const mutated = path.map((b, i) => i === 0 ? b : i === 1 ? { ...b, h: 13, l: 10.65, c: 12.9 } : { ...b, o: 20, h: 22, l: 19, c: 21 });
    expect(run(ex, plan, prior, mutated)).toEqual(a);
  });

  it("内存视图：别的代码 / 不提供的方法抛 ShadowViewUnsupported（结算侧据此退回 sqlite 视图）", () => {
    const v = memoryView(CODE, flat(0, 10, 10), DATES[5], SEC);
    expect(v.dailyBars(CODE, 99).map(b => b.date)).toEqual(DATES.slice(0, 6));
    expect(() => v.dailyBars("000001", 5)).toThrow(/ShadowViewUnsupported|不提供/);
    expect(() => v.ztPool(DATES[5])).toThrow(/不提供 ztPool/);
  });
});

/* ------------------------------- 落库：迁移、变体、重结算 ------------------------------- */

describe("库里的结算", () => {
  let t: TempDb;
  beforeEach(() => { t = makeTempDb(); insCalendar(t.db, DATES); insSecurity(t.db, CODE); });
  afterEach(() => { t.close(); });

  const HM = { 离场器: { 用: "游资纪律", 参数: { 止损: -0.08, 破线: "MA5", 炸板走: true } } };
  const register = () => {
    seedVariants(t.db, [{ id: "baseline", name: "baseline", slots: {}, note: "" }]);
    addVariant(t.db, { id: "r-exit-hard", name: "规则·炸板破线即走", slots: HM, note: "" });
  };
  const card = (cands: any[]) => ({ env: { gear: "中性" }, candidates: cands });
  const buy = (code: string, over: Record<string, unknown> = {}) =>
    ({ code, name: code, action: "买入", account: "卫星", triggerPx: 10.1, stopPx: 9.3, size: 0.1, score: 1, ...over });
  const record = (variants: string[], baseIdx: number, cands: any[], asOf = `${DATES[baseIdx + 1]} 09:15:00`) =>
    runShadowDay(t.db, {
      decidedOn: DATES[baseIdx + 1], baseDate: DATES[baseIdx], asOf, phase: "盘前", config: config(), source: "live",
      engineFor: () => () => card(cands), variants: variants.map(id => ({ id, name: id, slots: id === "baseline" ? {} : HM })),
    });
  /** 破 MA5 的那条路径：基准日 = DATES[29] */
  const writeMa5Path = (code = CODE, from = 25) => {
    const px: OHLC[] = [[9.6, 9.6, 9.6, 9.6], [9.8, 9.8, 9.8, 9.8], [10, 10, 10, 10], [10.2, 10.2, 10.2, 10.2], [10.4, 10.4, 10.4, 10.4],
      [10.3, 10.4, 10, 10.3], [10.3, 10.35, 9.95, 10], [10.05, 10.2, 9.9, 10.1], [10.1, 10.2, 10, 10.1], [10.1, 10.2, 10, 10.1]];
    px.forEach(([o, h, l, c], i) => insDaily(t.db, code, DATES[from + i], c, { o, h, l }));
  };
  const outcomes = () => Object.fromEntries((t.db.prepare(
    "SELECT p.variant_id v, o.* FROM shadow_outcome o JOIN shadow_pred p ON p.id = o.pred_id WHERE p.code != '-'").all() as any[])
    .map(r => [r.v, r]));

  it("029：新库上 shadow_outcome 有 exit_slot 列，迁移只跑一次", () => {
    const cols = (t.db.prepare("PRAGMA table_info(shadow_outcome)").all() as Array<{ name: string }>).map(c => c.name);
    expect(cols).toContain("exit_slot");
    expect(t.db.prepare("SELECT name FROM _migrations WHERE name LIKE '029%'").all()).toHaveLength(1);
  });

  it("r-exit-hard（只换离场器）与 baseline 同一笔入场结出不同结果，各自落 exit_slot", () => {
    register();
    record(["baseline", "r-exit-hard"], 29, [buy(CODE)]);
    writeMa5Path();
    expect(settleShadowPending(t.db, DATES[40])).toMatchObject({ settled: 2, failed: 0 });
    const o = outcomes();
    expect(o["baseline"]).toMatchObject({ exit_reason: "期满", exit_date: DATES[34], exit_slot: "离场器:账户纪律@1.0.0" });
    expect(o["r-exit-hard"]).toMatchObject({ exit_reason: "离场器", exit_date: DATES[32], exit_px: 10.05, exit_slot: "离场器:游资纪律@1.0.0" });
    expect(o["r-exit-hard"].entry_px).toBe(o["baseline"].entry_px);
  });

  it("离场器抛错：那一笔不落表、记 failed，其它照常", () => {
    register();
    t.db.prepare("UPDATE shadow_variant SET slot_config = ? WHERE id = 'r-exit-hard'").run(JSON.stringify({ 离场器: { 用: "没注册的槽" } }));
    record(["baseline", "r-exit-hard"], 29, [buy(CODE)]);
    writeMa5Path();
    expect(settleShadowPending(t.db, DATES[40])).toMatchObject({ settled: 1, failed: 1 });
    expect(Object.keys(outcomes())).toEqual(["baseline"]);
  });

  it("重结算：旧口径的行被识别为过期、重结后对上口径；再跑一遍结果不变；作废与 baseline 不动", () => {
    register();
    record(["baseline", "r-exit-hard"], 29, [buy(CODE)]);
    writeMa5Path();
    // 另一笔晚决策（作废）的
    record(["r-exit-hard"], 30, [buy("600002")], `${DATES[31]} 11:00:00`);
    settleShadowPending(t.db, DATES[40]);
    // 伪造 029 之前的旧结算：r-exit-hard 那行改成与 baseline 一样的老结果、exit_slot 为 NULL
    const b = outcomes()["baseline"];
    t.db.prepare(
      `UPDATE shadow_outcome SET exit_date = ?, exit_px = ?, exit_reason = ?, gross_pct = ?, net_pct = ?, mfe_pct = ?, mae_pct = ?, note = NULL, exit_slot = NULL
        WHERE pred_id IN (SELECT id FROM shadow_pred WHERE variant_id = 'r-exit-hard' AND code = ?)`
    ).run(b.exit_date, b.exit_px, b.exit_reason, b.gross_pct, b.net_pct, b.mfe_pct, b.mae_pct, CODE);
    t.db.prepare("UPDATE shadow_outcome SET exit_slot = NULL WHERE pred_id IN (SELECT id FROM shadow_pred WHERE variant_id = 'baseline')").run();

    // 旧口径的 baseline 行（NULL）仍算数；r-exit-hard 的旧行过期，统计里当没结
    expect(staleExitVariants(t.db)).toEqual(["r-exit-hard"]);
    expect(loadTrades(t.db, "baseline", "live").filter(x => x.status === "已结算")).toHaveLength(1);
    expect(loadTrades(t.db, "r-exit-hard", "live").filter(x => x.status === "已结算")).toHaveLength(0);
    expect(loadTrades(t.db, "r-exit-hard", "live").filter(x => x.status === "作废")).toHaveLength(1);

    const baseBefore = t.db.prepare("SELECT * FROM shadow_outcome WHERE pred_id LIKE '%:baseline:%'").all();
    const r1 = resettleShadow(t.db, DATES[40], staleExitVariants(t.db));
    expect(r1).toMatchObject({ removed: 1, settled: 1, failed: 0 });
    const strip = (rs: any[]) => rs.map(({ settled_at: _s, ...x }) => x);
    const after1 = strip(t.db.prepare("SELECT * FROM shadow_outcome ORDER BY pred_id").all() as any[]);
    expect(outcomes()["r-exit-hard"]).toMatchObject({ exit_reason: "离场器", exit_slot: "离场器:游资纪律@1.0.0" });
    expect(staleExitVariants(t.db)).toEqual([]);
    expect(loadTrades(t.db, "r-exit-hard", "live").filter(x => x.status === "已结算")).toHaveLength(1);

    // 幂等：指名再跑一遍，结果逐字段相同（settled_at 除外）
    const r2 = resettleShadow(t.db, DATES[40], ["r-exit-hard"]);
    expect(r2).toMatchObject({ removed: 1, settled: 1 });
    expect(strip(t.db.prepare("SELECT * FROM shadow_outcome ORDER BY pred_id").all() as any[])).toEqual(after1);
    // 作废行与 baseline 行没被碰过
    expect((t.db.prepare("SELECT status FROM shadow_outcome WHERE pred_id LIKE '%600002'").get() as any).status).toBe("作废");
    expect(t.db.prepare("SELECT * FROM shadow_outcome WHERE pred_id LIKE '%:baseline:%'").all()).toEqual(baseBefore);
  });

  it("耗时：300 笔走游资纪律的结算（另跑同样 300 笔 baseline 做对照）", () => {
    register();
    const N = 300;
    const codes = Array.from({ length: N }, (_, i) => `6${String(10000 + i).padStart(5, "0")}`);
    for (const c of codes) { insSecurity(t.db, c); writeMa5Path(c, 0); for (let i = 10; i < 40; i++) insDaily(t.db, c, DATES[i], 10.1); }
    // 同一条破 MA5 路径：基准日 DATES[4]（之前 4 根作均线窗口），成交日 DATES[5]，之后横盘
    record(["baseline"], 4, codes.map(c => buy(c)));
    record(["r-exit-hard"], 4, codes.map(c => buy(c)));
    const t0 = performance.now();
    const rb = settleShadowPending(t.db, DATES[60], { variantIds: ["baseline"] });
    const t1 = performance.now();
    const rh = settleShadowPending(t.db, DATES[60], { variantIds: ["r-exit-hard"] });
    const t2 = performance.now();
    expect(rb.settled).toBe(N);
    expect(rh.settled).toBe(N);
    console.log(`[耗时] 结算 ${N} 笔：baseline ${(t1 - t0).toFixed(0)} ms，游资纪律 ${(t2 - t1).toFixed(0)} ms（${((t2 - t1) / N).toFixed(2)} ms/笔）`);
    expect(t2 - t1).toBeLessThan(30_000);
  });
});
