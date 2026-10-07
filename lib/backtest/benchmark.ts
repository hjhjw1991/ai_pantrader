/**
 * 回测的基准对比。
 *
 * 为什么单独一个文件而不是塞进 metrics：基准是**外部取数**（另一条行情序列），
 * 不是从策略净值算出来的。BacktestReport 是一份带 resultHash 的不可变快照，
 * 把基准写进去，等于让同一份报告因为"后来又采了几天指数"而内容不同。
 * 所以基准不进契约，由调用方（CLI / API）取好、作为选项喂给 tearsheet。
 *
 * 对齐口径是这个文件唯一真正要紧的事：
 *
 *   **基准必须以策略的交易日为 x 轴。**
 *
 *   指数序列常常比策略净值长 —— 实测那份 2025-09→2026-09 的报告，
 *   区间内指数有 248 个交易日而策略只有 231 个点，多出来的 17 天
 *   正好是策略的数据缺口日（覆盖率 93.1% 缺的就是它们）。
 *   若各画各的日历，两条线在同一张图上是错位的，而错位**看起来完全正常**：
 *   峰值对不上、拐点差几天，读者只会觉得"策略在某段跑输了"，不会想到是轴不同。
 *   所以这里逐点按策略的日期取基准收盘，多出来的那些天一律丢弃，
 *   并把丢弃的天数报出来给报告显示。
 *
 * 反过来，策略有而基准没有的日子记 null：那是我们的指数数据缺，
 * 不是市场休市。统计时跳过配对，绝不填 0 或沿用前值 ——
 * 补一个假的"零收益日"会把波动和相关性一起压低。
 */
import type { Db } from "@/lib/db";
import { INDICES } from "@/lib/data/indices";
import { annualiseOf, dailyReturns, maxDrawdownOf, stdev } from "@/lib/backtest/series";
import type { EquityPoint } from "@/lib/contracts";

/** 默认基准。沪深300：A 股最常见的业绩比较基准，也是这套系统里采了日线的六条之一 */
export const DEFAULT_BENCHMARK = "sh000300";

export interface BenchmarkSeries {
  code: string;
  name: string;
  /**
   * 与策略净值**逐点同长、同日期**，已经归一到策略的初始资金。
   * null = 该交易日基准无数据。
   */
  equity: Array<number | null>;
  /** 策略有交易日、基准无数据的天数 */
  missingDays: number;
  /** 区间内基准自己有多少个交易日（比策略多的部分已丢弃） */
  availableDays: number;
}

export interface BenchmarkStats {
  /** 参与统计的有效配对天数（两边都有收益的那天） */
  paired: number;
  benchTotal: number | null;
  benchAnnual: number | null;
  benchMaxDD: number | null;
  /** 区间总收益之差：策略 − 基准 */
  excessTotal: number | null;
  /** 年化之差。两侧都由同一个 annualiseOf 算出 */
  excessAnnual: number | null;
  /** cov(rp,rb)/var(rb)。基准无波动时无定义，记 null */
  beta: number | null;
  /** 年化 alpha：策略年化 − beta × 基准年化 */
  alphaAnnual: number | null;
  correlation: number | null;
  /** 年化的跟踪误差：日超额的标准差 × √252 */
  trackingError: number | null;
  /** 信息比率 = 年化超额 / 跟踪误差 */
  infoRatio: number | null;
  /** 跑赢基准的交易日占比 */
  outperformingDays: number | null;
}

export type BenchmarkResult =
  | { ok: true; series: BenchmarkSeries; stats: BenchmarkStats }
  | { ok: false; reason: string };

/** 不是采了日线的指数一律拒绝：查不到还画出来，是"看起来有基准"的最坏一种 */
export function isKnownBenchmark(code: string): boolean {
  return INDICES.some(i => i.symbol === code);
}

export function benchmarkName(code: string): string {
  return INDICES.find(i => i.symbol === code)?.name ?? code;
}

/**
 * 取指数收盘并按策略的交易日对齐。
 *
 * 归一到策略的初始资金（`equity[0].equity`）：两条线起点相同，
 * 图上可以直接比高低。用策略的首日收盘而不是区间第一根指数 K 线做除法基数 ——
 * 两者在正常情况下是同一天，但策略净值首日才是这份回测真正的起算点。
 */
export function loadBenchmark(db: Db, code: string, equity: readonly EquityPoint[]): BenchmarkSeries | null {
  if (equity.length < 2) return null;
  if (!isKnownBenchmark(code)) return null;

  const from = equity[0]!.date;
  const to = equity[equity.length - 1]!.date;
  const rows = db.prepare(
    `SELECT date, c FROM kline_daily WHERE code = ? AND date BETWEEN ? AND ? ORDER BY date`
  ).all(code, from, to) as Array<{ date: string; c: number }>;
  if (rows.length < 2) return null;

  const closeAt = new Map<string, number>();
  for (const r of rows) closeAt.set(r.date, r.c);

  // 基准用自己的日历数出来的天数，仅用于报告说明"丢了多少天"
  const availableDays = rows.length;

  const base = equity[0]!.equity;
  const firstClose = closeAt.get(from);
  if (firstClose === undefined || !(firstClose > 0)) return null;

  const out: Array<number | null> = [];
  let missingDays = 0;
  for (const p of equity) {
    const c = closeAt.get(p.date);
    if (c === undefined || !(c > 0)) { out.push(null); missingDays++; continue; }
    out.push((base * c) / firstClose);
  }
  return { code, name: benchmarkName(code), equity: out, missingDays, availableDays };
}

/** 统计前的配对：只保留策略与基准在同一天都有收益的那些天 */
function pairReturns(
  equity: readonly EquityPoint[], bench: readonly (number | null)[]
): { rp: number[]; rb: number[]; benchSeries: Array<{ equity: number }> } {
  const rpAll = dailyReturns(equity);
  const rp: number[] = [];
  const rb: number[] = [];
  const benchSeries: Array<{ equity: number }> = [];

  for (const v of bench) if (v !== null) benchSeries.push({ equity: v });

  for (let i = 1; i < equity.length; i++) {
    const a = bench[i - 1], b = bench[i];
    if (a === null || b === null || a === undefined || b === undefined || !(a > 0)) continue;
    rp.push(rpAll[i - 1]!);
    rb.push(b / a - 1);
  }
  return { rp, rb, benchSeries };
}

function covariance(xs: readonly number[], ys: readonly number[]): number | null {
  const n = Math.min(xs.length, ys.length);
  if (n < 2) return null;
  const mx = xs.slice(0, n).reduce((a, b) => a + b, 0) / n;
  const my = ys.slice(0, n).reduce((a, b) => a + b, 0) / n;
  let s = 0;
  for (let i = 0; i < n; i++) s += (xs[i]! - mx) * (ys[i]! - my);
  return s / (n - 1);
}

/**
 * 对比统计。**年化与最大回撤走 series.ts 的同一套实现**
 * —— 见 series.ts 顶部：并排印在报告上的两个数必须是同一种算法。
 *
 * 基准含缺口时，年化/回撤用非 null 点组成的子序列算：
 * 缺口日对基准而言是"我们没数据"，跳过是唯一选择，报告里会把 missingDays 写出来。
 */
export function benchmarkStats(
  equity: readonly EquityPoint[], bench: readonly (number | null)[]
): BenchmarkStats | null {
  if (equity.length < 2 || bench.length !== equity.length) return null;
  const { rp, rb, benchSeries } = pairReturns(equity, bench);
  if (benchSeries.length < 2) return null;

  const first = equity[0]!.equity;
  const last = equity[equity.length - 1]!.equity;
  const stratTotal = first > 0 ? last / first - 1 : null;
  const stratAnnual = annualiseOf(equity);

  const benchTotal = benchSeries.length >= 2
    ? benchSeries[benchSeries.length - 1]!.equity / benchSeries[0]!.equity - 1
    : null;
  const benchAnnual = annualiseOf(benchSeries);
  const benchMaxDD = maxDrawdownOf(benchSeries);

  const cov = covariance(rp, rb);
  const varB = covariance(rb, rb);
  const sdP = stdev(rp);
  const bSd = stdev(rb);

  const beta = cov !== null && varB !== null && varB > 0 ? cov / varB : null;
  const correlation = cov !== null && sdP !== null && bSd !== null && sdP > 0 && bSd > 0
    ? cov / (sdP * bSd) : null;

  const diff = rp.map((v, i) => v - rb[i]!);
  const teDaily = stdev(diff);
  const trackingError = teDaily === null ? null : teDaily * Math.sqrt(252);

  const excessTotal = stratTotal !== null && benchTotal !== null ? stratTotal - benchTotal : null;
  const excessAnnual = stratAnnual - benchAnnual;
  const alphaAnnual = beta !== null ? stratAnnual - beta * benchAnnual : null;
  const infoRatio = trackingError !== null && trackingError > 0 && excessAnnual !== null
    ? excessAnnual / trackingError : null;

  return {
    paired: rp.length,
    benchTotal,
    benchAnnual,
    benchMaxDD,
    excessTotal,
    excessAnnual,
    beta,
    alphaAnnual,
    correlation,
    trackingError,
    infoRatio,
    outperformingDays: diff.length > 0 ? diff.filter(d => d > 0).length / diff.length : null,
  };
}

/** 一次拿全：调用方不必自己判断"取到了但算不出"的中间态 */
export function loadBenchmarkWithStats(
  db: Db, code: string, equity: readonly EquityPoint[]
): BenchmarkResult {
  if (!isKnownBenchmark(code)) {
    return { ok: false, reason: `${code} 不是已采集日线的指数（可选：${INDICES.map(i => i.symbol).join("、")}）` };
  }
  if (equity.length < 2) {
    return { ok: false, reason: "净值点不足 2 个，无法作对比" };
  }
  const series = loadBenchmark(db, code, equity);
  if (series === null) {
    return { ok: false, reason: `区间 ${equity[0]!.date}~${equity[equity.length - 1]!.date} 内没有 ${benchmarkName(code)} 的日线，或不足两天` };
  }
  const stats = benchmarkStats(equity, series.equity);
  if (stats === null) {
    return { ok: false, reason: `${benchmarkName(code)} 在该区间内可用数据不足，无法统计` };
  }
  return { ok: true, series, stats };
}
