/**
 * 影子盘统计：每个变体一份成绩单，以及与 baseline 的差异检验。
 *
 * 口径（毕业门槛直接读这些数，改之前先看 ④期3 的判定）：
 *   - 只算"已结算"的；"未触发"只进触发率
 *   - 胜率 = 净收益 > 0 的占比（净 = 扣双边滑点与费率）
 *   - 期望 = 平均净收益（百分点 / 笔）—— 毕业比的就是它
 *   - 盈亏比 = 平均盈利 / |平均亏损|；没有亏损时为 null，不是无穷大
 *   - 最大回撤：逐笔等权、按离场日排序累加净收益，取累计曲线的最大回落（百分点）。
 *     不做资金曲线：影子盘不管仓位与资金占用，逐笔等权是它唯一站得住的口径
 *   - 差异检验用 Welch t：两个变体的样本量与方差都不同，不能用合并方差
 */
import { mean, stdevPop } from "@/lib/factors/util";

export interface Trade {
  status: "已结算" | "未触发";
  netPct: number | null;
  exitDate: string | null;
  exitReason: string | null;
  stage: string | null;
  baseDate: string;
}

export interface Summary {
  settled: number;
  untriggered: number;
  triggerRate: number | null;
  winRate: number | null;
  meanNet: number | null;
  medianNet: number | null;
  payoff: number | null;
  maxDrawdown: number | null;
  byExit: Record<string, number>;
  byStage: Record<string, { n: number; meanNet: number | null; winRate: number | null }>;
  /** 最早 / 最晚基准日，给人看样本覆盖了哪段行情 */
  from: string | null;
  to: string | null;
}

const r6 = (x: number): number => Math.round(x * 1e6) / 1e6;

function nets(ts: Trade[]): number[] {
  return ts.filter(t => t.status === "已结算" && t.netPct !== null).map(t => t.netPct as number);
}

export function maxDrawdown(ts: Trade[]): number | null {
  const done = ts.filter(t => t.status === "已结算" && t.netPct !== null && t.exitDate !== null)
    .sort((a, b) => (a.exitDate! < b.exitDate! ? -1 : a.exitDate! > b.exitDate! ? 1 : 0));
  if (done.length === 0) return null;
  let cum = 0, peak = 0, dd = 0;
  for (const t of done) {
    cum += t.netPct as number;
    peak = Math.max(peak, cum);
    dd = Math.max(dd, peak - cum);
  }
  return r6(dd);
}

export function summarize(ts: Trade[]): Summary {
  const xs = nets(ts);
  const untriggered = ts.filter(t => t.status === "未触发").length;
  const wins = xs.filter(x => x > 0), losses = xs.filter(x => x < 0);
  const sorted = [...xs].sort((a, b) => a - b);
  const med = sorted.length === 0 ? null
    : sorted.length % 2 ? sorted[sorted.length >> 1] : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;

  const byExit: Record<string, number> = {};
  for (const t of ts) if (t.status === "已结算" && t.exitReason) byExit[t.exitReason] = (byExit[t.exitReason] ?? 0) + 1;
  const byStage: Summary["byStage"] = {};
  const stages = [...new Set(ts.filter(t => t.status === "已结算").map(t => t.stage ?? "未判"))];
  for (const s of stages) {
    const g = nets(ts.filter(t => (t.stage ?? "未判") === s));
    byStage[s] = {
      n: g.length,
      meanNet: g.length === 0 ? null : r6(mean(g)),
      winRate: g.length === 0 ? null : r6(g.filter(x => x > 0).length / g.length),
    };
  }
  const dates = ts.map(t => t.baseDate).sort();
  return {
    settled: xs.length, untriggered,
    triggerRate: xs.length + untriggered === 0 ? null : r6(xs.length / (xs.length + untriggered)),
    winRate: xs.length === 0 ? null : r6(wins.length / xs.length),
    meanNet: xs.length === 0 ? null : r6(mean(xs)),
    medianNet: med === null ? null : r6(med),
    payoff: wins.length === 0 || losses.length === 0 ? null : r6(mean(wins) / Math.abs(mean(losses))),
    maxDrawdown: maxDrawdown(ts),
    byExit, byStage,
    from: dates[0] ?? null, to: dates[dates.length - 1] ?? null,
  };
}

/**
 * 日度收益序列：同一基准日发出的推荐合成一个数，再按日排序。
 *
 * 为什么显著性检验只能吃这个、不能吃逐笔（2026-09-27 修正）：
 * 同一天成交的几笔**不是独立观测** —— 它们踩的是同一段行情、同一个择时判断，
 * 同涨同跌。按笔算 t 值会把"今天行情好"数成 N 份独立证据，于是
 * 13,294 笔混在一起能算出 t = 7.08 这种数；换成 690 个交易日的口径，
 * 同一个策略的日度 t 只有 1.66。前者是幻觉，后者才是真凭实据。
 *
 * 未触发的推荐记 0，不是跳过：那天挂单没成交，这笔机会就是没兑现
 * （等价于按预测数均分资金、没成交的那份资金闲置）。跳过它们等于宣称
 * "成交率不影响收益"，而挂单挂多低恰恰是靠成交率在起作用。
 */
export function dailyReturns(ts: Trade[]): number[] {
  const byDay = new Map<string, number[]>();
  for (const t of ts) {
    if (t.status === "已结算") {
      if (t.netPct === null) continue;
      if (!byDay.has(t.baseDate)) byDay.set(t.baseDate, []);
      byDay.get(t.baseDate)!.push(t.netPct);
    } else if (!byDay.has(t.baseDate)) {
      byDay.set(t.baseDate, []);                     // 未触发：占位 0，别让这天消失
    }
  }
  return [...byDay.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([, xs]) => (xs.length === 0 ? 0 : xs.reduce((s, x) => s + x, 0) / xs.length));
}

/** Welch t：a 的均值减 b 的均值，除以 sqrt(va/na + vb/nb)（样本方差，n−1） */
export function welch(a: number[], b: number[]): { diff: number; t: number; se: number } | null {
  if (a.length < 2 || b.length < 2) return null;
  const v = (xs: number[]) => (stdevPop(xs) ** 2) * xs.length / (xs.length - 1);
  const se = Math.sqrt(v(a) / a.length + v(b) / b.length);
  const diff = mean(a) - mean(b);
  return { diff: r6(diff), t: se === 0 ? 0 : r6(diff / se), se: r6(se) };
}
