/**
 * 净值序列上的纯数学。回测三处要用同一套：指标层算分、报告层派生、基准层对比。
 *
 * 为什么单抽一层：这几条式子在 `metrics.ts` 与 `tearsheet.ts` 里各存过一份，
 * 一字不差 —— 而**基准对比让重复从"不体面"变成"会出错"**。
 * 策略年化用 A 式、基准年化用 B 式，两个数并排印在报告上却不是同一种年化，
 * 读者无从发现，只会拿它去下结论。所以基准必须复用策略那一套，
 * 而不是"照着再写一遍一样的"。
 *
 * 这里只放**与渲染无关、与评分无关**的纯函数，不引 DB、不引时钟。
 */
/**
 * 年化折算用的交易日数。
 *
 * 它住在这里而不是 metrics.ts，是因为本文件不引 metrics —— 那边要从这边取函数，
 * 反过来引就成了环。metrics.ts 会 re-export 出去，对外名字不变。
 */
export const TRADING_DAYS_PER_YEAR = 252;

/** 只关心净值时用这个形状，不必是完整 EquityPoint */
export interface HasEquity {
  equity: number;
}

/**
 * 逐日收益率，长度 = n−1。
 *
 * 前值 ≤ 0 时记 0 而不是 NaN：净值归零之后"收益率"已无意义，
 * 而一个 NaN 会顺着均值/标准差污染后面所有指标，并且很难追到源头。
 */
export function dailyReturns(equity: readonly HasEquity[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < equity.length; i++) {
    const prev = equity[i - 1]!.equity;
    if (prev <= 0) { out.push(0); continue; }
    out.push(equity[i]!.equity / prev - 1);
  }
  return out;
}

/** 样本标准差（n−1）。少于两点无定义，返回 null 而不是 0 */
export function stdev(xs: readonly number[]): number | null {
  if (xs.length < 2) return null;
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  const v = xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1);
  return Math.sqrt(v);
}

/** 最大回撤，正数表示跌去的比例 */
export function maxDrawdownOf(equity: readonly HasEquity[]): number {
  let peak = -Infinity;
  let mdd = 0;
  for (const p of equity) {
    if (p.equity > peak) peak = p.equity;
    if (peak > 0) mdd = Math.max(mdd, (peak - p.equity) / peak);
  }
  return mdd;
}

/**
 * 年化：按交易日折算，折算天数 = n−1。
 *
 * 区间不足一年也照算 —— 是否可信由调用方按 MIN_SAMPLE_DAYS 判退化，
 * 这里不擅自返回"不够格"的哨兵值：同一个函数既要给引擎评分用、又要给报告用，
 * 而评分与报告对"不足一年"的处理本来就不一样。
 */
export function annualiseOf(equity: readonly HasEquity[]): number {
  if (equity.length < 2) return 0;
  const start = equity[0]!.equity;
  const end = equity[equity.length - 1]!.equity;
  if (start <= 0) return 0;
  const periods = equity.length - 1;
  const total = end / start;
  // 亏光了：年化 −100%。不做 Math.pow(负数, 小数)，那会产生 NaN
  if (total <= 0) return -1;
  return Math.pow(total, TRADING_DAYS_PER_YEAR / periods) - 1;
}
