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
  /** 单边费用率（佣金+印花税+过户费合计近似） */
  feeRate: number;
  minFee: number;
}

/**
 * 2026-09-27 按 A 股现行费率重校，不再是拍脑袋的保守值。
 *
 * 旧值 slippage 0.002 / feeRate 0.0013 合计双边 0.66%，比真实成本高出一倍多：
 *   · 费用：佣金万 2.5（0.025%，双边）+ 过户费 0.001%（双边）+ 印花税 0.05%（仅卖出）
 *     → 买入 0.026%、卖出 0.076%，平均单边 ≈ 0.05%。旧值 0.13% 相当于把佣金按万 13 算。
 *   · 滑点：主板活跃股挂限价单，成交价就是挂单价，滑点接近 0；
 *     取 0.1%/边 已经是对"排队靠后、价格跑掉"的保守计提。旧值 0.2%/边没有依据。
 *
 * 为什么要改：成本假设决定"什么样的策略算有优势"。0.66% 的门槛下，
 * 影子盘 13,294 笔回放里所有变体的净期望都是负的 —— 那判不出策略好坏，
 * 只判出"手续费太贵"。把成本校准到现实（双边 0.30%）之后，
 * 同一批样本里 baseline 变体在 -3% 折让下的日度收益 +0.36%/日（t = 2.08），
 * 差异才重新可辨。
 *
 * 校准后 **历史影子盘样本已按新口径重算**（见 analysis/重算成本口径-影子盘.cjs）：
 * 成本常数一换，新旧样本就不是一个分母里的东西，不重算等于拿两个口径做毕业判定。
 */
export const DEFAULT_CONSTRAINTS: Constraints = {
  t1: true,
  limitUpUnbuyable: true,
  limitDownUnsellable: true,
  suspensionBlocks: true,
  slippage: 0.001,
  feeRate: 0.0005,
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
  /**
   * 触发率：发出的买入决策里，价格真到了买点因而成交的比例。
   *
   * 为什么它和胜率一样重要：胜率只在成交的那些单子上算，
   * 一个"触发率 10%、胜率 80%"的策略单看胜率是满分，实际一年做不了几笔 ——
   * 那 80% 是纸上的。没有这个数就看不出策略是选股不行，还是买点定得够不到。
   *
   * 分母只算"因为价格没到"而未成交的（未触及限价），
   * 不含涨停封板/停牌/资金不足 —— 那些是约束问题，不是买点定得对不对的问题。
   * 没有买入决策时为 null，不编 0。
   */
  triggerRate: number | null;
  /** 触发率的分子/分母，给人看清样本量 */
  buyDecisions: number;
  buyFilled: number;
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
   * 选择偏差：试了 N 个组合取最好的那个，成绩被"挑"这个动作抬高了。
   *
   * 与 peak 互补，两个都要看：peak 看**形状**（最优点旁边是不是悬崖），
   * selection 看**次数**（一共挑了多少次）。一片平缓的高原上也能挑出"最好"
   * （peak 不报），但如果这片高原是试了 36 次才出现的，那个最好仍然带着运气。
   *
   * chanceCeiling = 什么都不做、纯靠挑最好能挑到多高；
   * deflated = 最优点扣掉这份运气后剩下的。deflated ≤ 0 就是过拟合嫌疑。
   *
   * 老存档可能没有这个字段（它是后补的）—— 渲染处按缺失处理，不脑补成 0。
   */
  selection: {
    trials: number;
    mean: number;
    sd: number;
    chanceCeiling: number;
    deflated: number;
    overfitSuspected: boolean;
    note: string;
  };
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
