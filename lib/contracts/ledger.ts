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

/**
 * 判定。
 *
 * 未触发 是第四类，不是"中性"的一种：
 *   中性   —— 到过买点、买了、涨跌落在中性带里（有方向承诺，只是没走出来）
 *   未触发 —— 价格根本没到推荐的买点，这笔推荐从未成为一个仓位
 * 两者都不进胜率分母，但病因完全不同：前者是"看得不够准"，
 * 后者是"买点定得够不到"。混成一类，就再也分不出该改选股还是该改触发价。
 */
export type Verdict = "命中" | "偏差" | "中性" | "未触发";

/** 进胜率分母的判定：只有真形成了方向承诺并且有结果的才算 */
export function countsTowardWinRate(v: Verdict): boolean {
  return v === "命中" || v === "偏差";
}

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
  /**
   * 实际涨跌幅，按 evalHorizon 对账。
   *
   * 起算价是**实际成交价 entryPx**，不是基准日收盘价 ——
   * 推荐说的是"到 trigger_px 才动手"，拿一个系统从没说过要买的价去记功记过，
   * 等于给策略换了一道它没做过的题。未触发时为 null：没有仓位就没有盈亏。
   */
  actualPct: number | null;
  errorType: ErrorType | null;
  /** 归因说明，人看的 */
  attribution: string;
  settledAt: string;

  /**
   * 价格到没到推荐的买点。null = 这条推荐没有 trigger_px（清仓类动作，无条件执行）。
   *
   * 这是复盘的第一道闸：触发率低的策略，胜率再高也没用 ——
   * 它推荐的那些买点根本够不到，那些漂亮的胜率是纸上的。
   */
  triggered: boolean | null;
  /** 实际成交基准价。限价成交口径见 lib/ledger/reconcile */
  entryPx: number | null;
  entryDate: string | null;
  /** 区间内最大有利偏移（相对 entryPx，百分比，正数） */
  mfePct: number | null;
  /** 区间内最大不利偏移（相对 entryPx，百分比，负数） */
  maePct: number | null;
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
