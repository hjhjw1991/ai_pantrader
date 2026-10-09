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
 *   指数序列常常比策略净值长 —— 区间内指数自己的交易日往往比策略的净值点多出十几天，
 *   多出来的那些天正好是策略的数据缺口日（覆盖率不到 100% 缺的就是它们）。
 *   具体差几天随区间与采集进度变，以报告里写出的 availableDays / 丢弃天数为准。
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
  /**
   * 策略首日没有基准数据时，基准从哪一天起算（第一个两边都有数据的交易日）。
   * 此时基准归一到策略**当天**的净值，之前的点记 null（计入 missingDays）。
   * 与策略首日对齐时不出现这个字段。
   */
  alignedFrom?: string;
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
  const r = alignBenchmark(db, code, equity);
  return typeof r === "string" ? null : r;
}

/** 取不成时返回原因（字符串），而不是一个笼统的 null —— 原因要原样写进报告 */
function alignBenchmark(db: Db, code: string, equity: readonly EquityPoint[]): BenchmarkSeries | string {
  if (equity.length < 2) return "净值点不足 2 个，无法作对比";
  if (!isKnownBenchmark(code)) return `${code} 不是已采集日线的指数`;

  const from = equity[0]!.date;
  const to = equity[equity.length - 1]!.date;
  const rows = db.prepare(
    `SELECT date, c FROM kline_daily WHERE code = ? AND date BETWEEN ? AND ? ORDER BY date`
  ).all(code, from, to) as Array<{ date: string; c: number }>;
  if (rows.length < 2) {
    return `区间 ${from}~${to} 内没有 ${benchmarkName(code)} 的日线，或不足两天（只有 ${rows.length} 天）`;
  }

  const closeAt = new Map<string, number>();
  for (const r of rows) closeAt.set(r.date, r.c);

  // 基准用自己的日历数出来的天数，仅用于报告说明"丢了多少天"
  const availableDays = rows.length;

  // 起算点 = 第一个两边都有数据的交易日。策略首日恰好缺指数（我们的指数数据缺了那天）
  // 不该让整块基准消失 —— 从第一个共同日起算，前面那几天如实记 null
  const k = equity.findIndex((p) => {
    const c = closeAt.get(p.date);
    return c !== undefined && c > 0;
  });
  if (k < 0) {
    return `区间 ${from}~${to} 内有 ${rows.length} 天 ${benchmarkName(code)} 日线，但与策略的交易日没有一天重合`;
  }
  const base = equity[k]!.equity;
  const firstClose = closeAt.get(equity[k]!.date)!;
  if (!(base > 0)) return `策略在基准起算日 ${equity[k]!.date} 的净值非正，无法归一`;

  const out: Array<number | null> = [];
  let missingDays = 0;
  for (const p of equity) {
    const c = closeAt.get(p.date);
    if (c === undefined || !(c > 0)) { out.push(null); missingDays++; continue; }
    out.push((base * c) / firstClose);
  }
  const series: BenchmarkSeries = { code, name: benchmarkName(code), equity: out, missingDays, availableDays };
  if (k > 0) series.alignedFrom = equity[k]!.date;
  return series;
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

  // 策略一侧的区间收益/年化与基准用**同一个起点**：基准从第一个非 null 点起算，
  // 策略也从那天起算 —— 否则"超额"是两段不同区间的收益相减
  const k = bench.findIndex((v) => v !== null);
  const stratSeg = k > 0 ? equity.slice(k) : equity;
  const first = stratSeg[0]!.equity;
  const last = stratSeg[stratSeg.length - 1]!.equity;
  const stratTotal = first > 0 ? last / first - 1 : null;
  const stratAnnual = annualiseOf(stratSeg);

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
  const series = alignBenchmark(db, code, equity);
  if (typeof series === "string") return { ok: false, reason: series };
  const stats = benchmarkStats(equity, series.equity);
  if (stats === null) {
    return { ok: false, reason: `${benchmarkName(code)} 在该区间内可用数据不足，无法统计` };
  }
  return { ok: true, series, stats };
}
