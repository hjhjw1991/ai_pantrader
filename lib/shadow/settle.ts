/**
 * 影子盘结算：按止损 / 目标价模拟离场。纯函数，只吃 K 线。
 *
 * 口径是用户 2026-09-23 定的，与正式台账（持有 5 天看收盘）刻意不同：
 * 影子盘要比出"定价类"策略的价值，而目标价与止损只有在结算里真的触发，才谈得上盈亏比。
 *
 *   成交：只看基准日之后的**第一个交易日**（与正式台账、回测撮合一致，TRIGGER_WINDOW = 1），
 *         最低价 ≤ 触发价即成交，价 = min(开盘, 触发价)
 *   T+1：买入当天不能卖。止损 / 目标最早从第 2 天起判
 *   离场（第 2 天起逐日）：
 *     - 开盘就在止损下方 → 按开盘价（跳空低开，止损单成交在开盘）
 *     - 开盘就在目标上方 → 按开盘价（跳空高开，比目标更好）
 *     - 盘中同时碰到止损与目标 → 按止损（日线看不出先后，取保守）
 *     - 只碰到其一 → 按那个价
 *     - 第 H 天收盘仍在场 → 按收盘价（期满）
 *   一字跌停：挂了卖单也成交不了，顺延到下一个不是一字跌停的交易日，按开盘价出
 *   除权：持有期内的 K 线按复权因子换算到成交日的价格尺度 —— 10 送 10 之后价格腰斩，
 *         那不是亏了一半
 *
 * K 线不够（停牌、还没走完持有期）一律"待定"：拿半截结果结算，
 * 胜率会被"恰好先走完的那批"决定，而先走完的往往是更早碰到止损的。
 */
import type { DailyBar } from "@/lib/contracts";

export interface ShadowPlan {
  triggerPx: number;
  stopPx: number | null;
  targetPx: number | null;
}

export interface SettleOpts {
  /** 持有期交易日数，从成交日算起（成交日是第 1 天） */
  horizon: number;
  /** 单边滑点与费率（与回测 DEFAULT_CONSTRAINTS 同口径） */
  slippage: number;
  feeRate: number;
  /** 一字跌停最多顺延几天，超了就待定 */
  maxDefer?: number;
  /**
   * 基准日（下决定那天）的复权因子。触发价 / 止损 / 目标是按基准日的原始价定的，
   * 成交日若恰好是除权日，原始价会整体跳低 —— 不换算的话，10 送 10 那天
   * "最低价 ≤ 触发价"必然成立，凭空多出一笔成交。缺省视为与成交日相同。
   */
  baseAdjFactor?: number;
}

export type ExitReason = "止损" | "目标" | "期满";

export interface ShadowSettlement {
  status: "已结算" | "未触发" | "待定";
  entryDate: string | null;
  entryPx: number | null;
  exitDate: string | null;
  exitPx: number | null;
  exitReason: ExitReason | null;
  /** 百分点。gross 不含成本，net 含双边滑点与费率 */
  grossPct: number | null;
  netPct: number | null;
  mfePct: number | null;
  maePct: number | null;
  note: string | null;
}

const EMPTY: Omit<ShadowSettlement, "status"> = {
  entryDate: null, entryPx: null, exitDate: null, exitPx: null, exitReason: null,
  grossPct: null, netPct: null, mfePct: null, maePct: null, note: null,
};

const r6 = (x: number): number => Math.round(x * 1e6) / 1e6;

/** bars：基准日**之后**的日线，升序，原始价带复权因子 */
export function settleShadow(plan: ShadowPlan, bars: DailyBar[], o: SettleOpts): ShadowSettlement {
  if (bars.length === 0) return { status: "待定", ...EMPTY, note: "基准日之后还没有 K 线（停牌或未到）" };
  const d1 = bars[0];
  // 计划价换算到成交日的原始价尺度（见 baseAdjFactor 的说明）
  const k = o.baseAdjFactor !== undefined && o.baseAdjFactor > 0 && d1.adjFactor > 0 ? o.baseAdjFactor / d1.adjFactor : 1;
  const p: ShadowPlan = {
    triggerPx: plan.triggerPx * k,
    stopPx: plan.stopPx === null ? null : plan.stopPx * k,
    targetPx: plan.targetPx === null ? null : plan.targetPx * k,
  };
  if (d1.l > p.triggerPx) return { status: "未触发", ...EMPTY, entryDate: d1.date };

  const entry = Math.min(d1.o, p.triggerPx);
  const f0 = d1.adjFactor > 0 ? d1.adjFactor : 1;
  const sc = (x: number, b: DailyBar) => (b.adjFactor > 0 ? (x * b.adjFactor) / f0 : x);

  let hi = d1.h, lo = d1.l;
  let deferred: ExitReason | null = null;
  let note: string | null = null;
  const lastIdx = o.horizon - 1 + (o.maxDefer ?? 10);

  const done = (i: number, px: number, reason: ExitReason): ShadowSettlement => {
    const s = o.slippage, f = o.feeRate;
    const gross = (px / entry - 1) * 100;
    const net = ((px * (1 - s) * (1 - f)) / (entry * (1 + s) * (1 + f)) - 1) * 100;
    return {
      status: "已结算", entryDate: d1.date, entryPx: r6(entry),
      exitDate: bars[i].date, exitPx: r6(px), exitReason: reason,
      grossPct: r6(gross), netPct: r6(net),
      mfePct: r6((Math.max(hi, px) / entry - 1) * 100), maePct: r6((Math.min(lo, px) / entry - 1) * 100),
      note,
    };
  };

  for (let i = 1; i < bars.length && i <= lastIdx; i++) {
    const b = bars[i];
    const bo = sc(b.o, b), bh = sc(b.h, b), bl = sc(b.l, b), bc = sc(b.c, b);
    const prevC = sc(bars[i - 1].c, bars[i - 1]);
    const lockedDown = Math.abs(bh - bl) < 1e-9 && bc < prevC;

    if (lockedDown) {
      // 一字跌停：今天什么都卖不出去。记下"本该离场"的原因，明天开盘再走
      hi = Math.max(hi, bh); lo = Math.min(lo, bl);
      if (deferred === null) {
        if (p.stopPx !== null && bl <= p.stopPx) deferred = "止损";
        else if (i >= o.horizon - 1) deferred = "期满";
        if (deferred !== null) note = `${b.date} 一字跌停卖不出，顺延`;
      }
      continue;
    }
    if (deferred !== null) return done(i, bo, deferred);

    // 跳空：开盘价就越过了线，挂单在开盘成交
    if (p.stopPx !== null && bo <= p.stopPx) return done(i, bo, "止损");
    if (p.targetPx !== null && bo >= p.targetPx) return done(i, bo, "目标");

    const stopHit = p.stopPx !== null && bl <= p.stopPx;
    const tgtHit = p.targetPx !== null && bh >= p.targetPx;
    // 止损当天只确知开盘价在止损之前出现过；当天的最高价可能在止损之后，不算进 MFE
    if (stopHit) { lo = Math.min(lo, p.stopPx!); hi = Math.max(hi, bo); return done(i, p.stopPx!, "止损"); }
    if (tgtHit) { hi = Math.max(hi, p.targetPx!); lo = Math.min(lo, bl); return done(i, p.targetPx!, "目标"); }

    hi = Math.max(hi, bh); lo = Math.min(lo, bl);
    if (i === o.horizon - 1) return done(i, bc, "期满");
  }
  return { status: "待定", ...EMPTY, entryDate: d1.date, entryPx: r6(entry), note: note ?? "持有期还没走完" };
}
