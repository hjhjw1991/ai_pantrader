import type { Action, AccountType, EnvGear, Phase } from "@/lib/contracts/strategy";

/**
 * 自校准闭环（spec §11）。
 *
 * 诚实定义：这不是模型自训练，是规则库 + 参数随实盘对账进化。
 * 目标是"错误不重犯"，不承诺神预测。
 */

export interface Prediction {
  id: string;
  ts: string;
  phase: Phase;
  code: string;
  strategyId: string;
  action: Action;
  account: AccountType;
  triggerPx: number | null;
  stopPx: number | null;
  size: number;
  thesis: string;
  gear: EnvGear;
  /** 判定期限，对齐龙虎榜自带的 D1/D5/D10 */
  evalHorizon: 1 | 5 | 10 | 20 | 30;
  validUntil: string;
  /** Claude 是否改过这条信号，A/B 量化贡献要靠它分组（spec §5.3） */
  advisorInfluenced: boolean;
}

export type Verdict = "命中" | "偏差" | "中性";

/**
 * 错误类型固定枚举，不许自由文本 —— 聚类统计频次才能驱动参数反馈。
 * 这四类来自实际复盘：
 *   瞬时价误判 —— 用了旧缓存价或盘中抖动价下判断
 *   板块漏扫   —— 主线在必查链里但没扫到（2026-07-27 的根因）
 *   逆势扛     —— 破止损没走
 *   追高       —— 在位置涨幅上限外买入
 */
export type ErrorType = "瞬时价误判" | "板块漏扫" | "逆势扛" | "追高" | "其他";

export interface Outcome {
  predId: string;
  verdict: Verdict;
  /** 实际涨跌幅，按 evalHorizon 对账 */
  actualPct: number;
  errorType: ErrorType | null;
  /** 归因说明，人看的 */
  attribution: string;
  settledAt: string;
}

export interface WinRateStats {
  total: number;
  hit: number;
  rate: number;
  byPhase: Record<Phase, { total: number; hit: number }>;
  byErrorType: Record<string, number>;
  /** 有 Advisor 参与 vs 无参与的命中率对比（spec §5.3） */
  advisorAB: { with: { total: number; hit: number }; without: { total: number; hit: number } };
}

/** 某类错误高频 → 触发对应参数调整建议。只出建议，不自动改参。 */
export interface ParamSuggestion {
  errorType: ErrorType;
  occurrences: number;
  /** strategy.yaml 里的路径，如 "持仓.卫星账户.止损" */
  paramPath: string;
  current: unknown;
  suggested: unknown;
  rationale: string;
}
