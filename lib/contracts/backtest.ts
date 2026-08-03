import type { StrategyConfig } from "@/lib/contracts/strategy";

/** A股约束（spec §10.1）。关掉任何一条都会让回测虚高，所以默认全开。 */
export interface Constraints {
  /** T+1：当日买入不可卖出 */
  t1: boolean;
  /** 涨停封板买不进，按封单额判成交概率 */
  limitUpUnbuyable: boolean;
  /** 跌停卖不出 */
  limitDownUnsellable: boolean;
  /** 停牌不成交 */
  suspensionBlocks: boolean;
  /** 滑点，成交价的比例 */
  slippage: number;
  /** 双边费用率（佣金+印花税+过户费合计近似） */
  feeRate: number;
  minFee: number;
}

export const DEFAULT_CONSTRAINTS: Constraints = {
  t1: true,
  limitUpUnbuyable: true,
  limitDownUnsellable: true,
  suspensionBlocks: true,
  slippage: 0.002,
  feeRate: 0.0013,
  minFee: 5,
};

export interface EquityPoint { date: string; equity: number; position: number }

export interface BacktestMetrics {
  /** 优化目标是 Calmar（年化/最大回撤），不是纯收益（spec §10.4） */
  calmar: number;
  annualReturn: number;
  maxDrawdown: number;
  sharpe: number;
  winRate: number;
  profitFactor: number;
  trades: number;
  avgHoldDays: number;
}

/**
 * 回测报告首页必含项（spec §10.5）。这四个字段不是可选装饰：
 * 覆盖率低、有缺口、有低置信因子、有效区间短，都会让 metrics 失去意义，
 * 只报收益不报这些等于骗自己。
 */
export interface CoverageReport {
  /** 有效交易日 / 应有交易日 */
  coverage: number;
  gapDays: number;
  /** ρ<0.8 的代理因子，报告首页标红 */
  lowConfidenceFactors: Array<{ name: string; rho: number }>;
  /** 实际有效回测区间。spec R1：复权断层可能让它只有 2.6 年而非 4 年 */
  effectiveRange: { from: string; to: string };
}

export interface BacktestReport {
  strategyId: string;
  strategyVersion: string;
  config: StrategyConfig;
  range: { from: string; to: string };
  constraints: Constraints;
  metrics: BacktestMetrics;
  equity: EquityPoint[];
  coverage: CoverageReport;
  /** 样本内/外分割结果。样本外不过就是不过，不许回头调样本内 */
  split?: { inSample: BacktestMetrics; outOfSample: BacktestMetrics };
  /** 同份输入两次运行必须一致（spec §17 断言 4） */
  resultHash: string;
}

export interface WalkForwardWindow {
  train: { from: string; to: string };
  test: { from: string; to: string };
  bestParams: Record<string, unknown>;
  testMetrics: BacktestMetrics;
}
