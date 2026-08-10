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

/**
 * 参数扫描（热力图）的结果。
 *
 * 为什么要在契约层立这个类型：寻优层（lib/backtest/optimizer.ts）早就有
 * `optimize()` / `heatmap()`，但它们的返回类型属于寻优层内部，不是 BacktestReport
 * 的一部分。前端要画图就得有个跨层的形状可依，**而前端不许自己发明契约** ——
 * 发明出来的字段迟早和引擎的真实产出漂移，图还照画，人照看。
 *
 * 单元格是 **Calmar**，与 optimize() 的目标一致（spec §10.4）。
 * 附带 peak/sensitivity 不是装饰：一个只在某点好、隔壁全烂的参数不是发现，是巧合。
 */
export interface SweepCell {
  /** 该 (x,y) 组合下的最好 Calmar。没评估过为 null */
  calmar: number | null;
}

export interface SweepHeatmap {
  axisX: string;
  axisY: string;
  /** 轴刻度，顺序即渲染顺序 */
  x: unknown[];
  y: unknown[];
  /** cells[y][x] */
  cells: Array<Array<number | null>>;
}

export interface SweepAxisSensitivity {
  axis: string;
  points: Array<{ value: unknown; bestCalmar: number; meanCalmar: number }>;
}

export interface SweepReport {
  strategyId: string;
  strategyVersion: string;
  range: { from: string; to: string };
  constraints: Constraints;
  /** 扫了哪些轴、每轴哪些取值。原样回显，让人能核对自己扫的是什么 */
  grid: Record<string, unknown[]>;
  /** 实际评估的组合数（= 网格点数，本实现不做由粗到精细化） */
  evaluated: number;
  best: { params: Record<string, unknown>; metrics: BacktestMetrics };
  heatmap: SweepHeatmap;
  sensitivity: SweepAxisSensitivity[];
  /** 峰形。overfitRisk=true 时界面必须显著标出 */
  peak: { sharpness: number; neighbourMeanCalmar: number; overfitRisk: boolean };
  /**
   * 覆盖率取自**最优点那次回测**的报告。
   * 不取平均也不省略：覆盖率 60% 的 Calmar 3.0 和覆盖率 99% 的 Calmar 1.5，
   * 后者才是可信的那个，热力图上的颜色深浅在覆盖率低时一律不可当结论。
   */
  coverage: CoverageReport;
  warnings: string[];
  generatedAt: string;
}

export interface WalkForwardWindow {
  train: { from: string; to: string };
  test: { from: string; to: string };
  bestParams: Record<string, unknown>;
  testMetrics: BacktestMetrics;
}
