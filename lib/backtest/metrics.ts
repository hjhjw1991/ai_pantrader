import type { BacktestMetrics, EquityPoint } from "@/lib/contracts";
import type { BlockedRecord, ClosedTrade, ReplayTrade } from "@/lib/backtest/types";

/**
 * 回测指标（spec §10.4）。优化目标是 **Calmar = 年化 / 最大回撤**，不是纯收益。
 *
 * 这个文件里最重要的不是公式，是退化情形的处理。三种退化：
 *   零回撤    —— 年化/0 = Infinity，会在寻优里排第一，而它通常意味着"只交易了两次且都赚了"
 *   笔数太少  —— 5 笔全赚的胜率 100% 没有统计意义
 *   区间不足一年 —— 把 3 个月的 8% 年化成 36% 是最常见的自欺方式
 *
 * 统一处理：**Calmar 记 0**。为什么是 0 而不是 NaN/Infinity/null：
 *   - 寻优是"最大化 Calmar"，0 让所有退化解自动沉到底，不需要在寻优里再写特判；
 *   - 0 不可能被误读成"好成绩"，而 Infinity 恰恰会；
 *   - 类型是 number（契约冻结），NaN 会污染排序和 JSON 序列化。
 * 原始 Calmar 不丢，走 computeMetricsDetailed().rawCalmar，报告里可以带 caveat 展示。
 */

export const TRADING_DAYS_PER_YEAR = 252;
/** 少于这个笔数，胜率/盈亏比没有统计意义 */
export const MIN_SAMPLE_TRADES = 30;
/** 少于这个交易日数，年化是放大噪音 */
export const MIN_SAMPLE_DAYS = TRADING_DAYS_PER_YEAR;

export interface MetricsInput {
  equity: EquityPoint[];
  closed: ClosedTrade[];
  /** 实际成交流水，用来数买入成交笔数（触发率的分子） */
  trades?: ReplayTrade[];
  /** 被拦下的决策，用来数"价格没到买点"的笔数（触发率分母的另一半） */
  blocked?: BlockedRecord[];
}

export interface DetailedMetrics {
  metrics: BacktestMetrics;
  /** 退化原因，非空即表示 calmar 被强制记 0 */
  degeneracy: string[];
  /** 退化前的原始 Calmar；零回撤时为 null（数学上无定义） */
  rawCalmar: number | null;
}

export function maxDrawdown(equity: EquityPoint[]): number {
  let peak = -Infinity;
  let mdd = 0;
  for (const p of equity) {
    if (p.equity > peak) peak = p.equity;
    if (peak > 0) mdd = Math.max(mdd, (peak - p.equity) / peak);
  }
  return mdd;
}

function dailyReturns(equity: EquityPoint[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < equity.length; i++) {
    const prev = equity[i - 1].equity;
    if (prev <= 0) { out.push(0); continue; } // 净值归零后不再产生有意义的收益率
    out.push(equity[i].equity / prev - 1);
  }
  return out;
}

/** 年化：按交易日折算。区间不足一年也照算，但会被标退化 */
function annualise(equity: EquityPoint[]): number {
  if (equity.length < 2) return 0;
  const start = equity[0].equity;
  const end = equity[equity.length - 1].equity;
  if (start <= 0) return 0;
  const periods = equity.length - 1;
  const total = end / start;
  if (total <= 0) return -1; // 亏光了：年化 −100%，不做 Math.pow(负数, 小数) 产生 NaN
  return Math.pow(total, TRADING_DAYS_PER_YEAR / periods) - 1;
}

function sharpe(equity: EquityPoint[]): number {
  const r = dailyReturns(equity);
  if (r.length < 2) return 0;
  const mean = r.reduce((a, b) => a + b, 0) / r.length;
  // 样本标准差（n−1）：回测净值是样本不是总体
  const varSample = r.reduce((a, b) => a + (b - mean) ** 2, 0) / (r.length - 1);
  const sd = Math.sqrt(varSample);
  if (sd === 0) return 0; // 无波动 → 无风险调整意义，不返回 Infinity
  return (mean / sd) * Math.sqrt(TRADING_DAYS_PER_YEAR);
}

export function computeMetricsDetailed(input: MetricsInput): DetailedMetrics {
  const { equity, closed } = input;
  const mdd = maxDrawdown(equity);
  const annualReturn = annualise(equity);

  const wins = closed.filter((t) => t.pnl > 0);
  const losses = closed.filter((t) => t.pnl <= 0);
  const grossWin = wins.reduce((a, t) => a + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((a, t) => a + t.pnl, 0));

  const degeneracy: string[] = [];
  if (mdd === 0) degeneracy.push("零回撤");
  if (closed.length < MIN_SAMPLE_TRADES) {
    degeneracy.push(`交易笔数 ${closed.length} < ${MIN_SAMPLE_TRADES}，无统计意义`);
  }
  // 按净值点数（= 回放到的交易日数）判，不按收益率个数：252 个交易日就是一年，
  // 对应 251 个日收益 —— 拿 251 去比 252 会把整整一年的样本误判成不足一年
  if (equity.length < MIN_SAMPLE_DAYS) {
    degeneracy.push(`样本区间 ${equity.length} 个交易日不足 ${MIN_SAMPLE_DAYS}（一年）`);
  }

  /**
   * 触发率。分母 = 买入成交笔数 + 因"未触及限价"被拦下的笔数。
   *
   * 只算这两类是关键：涨停封板、停牌、T+1、资金不足都是**约束**导致的没买上，
   * 和"买点定得够不到"是两码事。把它们混进分母，触发率就变成了一个
   * 同时反映买点合理性和资金规模的混合指标，改哪个都动它，也就没法用它做判断。
   */
  const buyFilled = (input.trades ?? []).filter((t) => t.side === "buy").length;
  const missedLimit = (input.blocked ?? [])
    .filter((b) => b.side === "buy" && b.blockedBy === "未触及限价").length;
  const buyDecisions = buyFilled + missedLimit;

  const rawCalmar = mdd === 0 ? null : annualReturn / mdd;
  const metrics: BacktestMetrics = {
    calmar: degeneracy.length > 0 ? 0 : (rawCalmar ?? 0),
    annualReturn,
    maxDrawdown: mdd,
    sharpe: sharpe(equity),
    winRate: closed.length === 0 ? 0 : wins.length / closed.length,
    // 没有亏损单 = 样本不足以估盈亏比，记 0 而不是 Infinity（同 Calmar 的理由）
    profitFactor: grossLoss === 0 ? 0 : grossWin / grossLoss,
    trades: closed.length,
    avgHoldDays: closed.length === 0 ? 0 : closed.reduce((a, t) => a + t.holdDays, 0) / closed.length,
    triggerRate: buyDecisions === 0 ? null : buyFilled / buyDecisions,
    buyDecisions, buyFilled,
  };
  return { metrics, degeneracy, rawCalmar };
}

export function computeMetrics(input: MetricsInput): BacktestMetrics {
  return computeMetricsDetailed(input).metrics;
}
