/**
 * 因子层入口。策略 YAML 靠因子名引用因子，注册表是那个名字空间的唯一来源。
 *
 * 硬约束（spec §17 断言 2/3）：本目录零网络、零存储访问、不取系统时间、不用随机数、
 * 无可变模块级状态。所有数据从 ctx.view (PointInTimeView) 进来，"现在"是 view.asOf。
 * 注意 CI 是按字面 grep 的，连注释里都不能出现那几个被禁的标识符。
 */
import type { FactorSpec } from "@/lib/contracts";
import { createRegistry } from "@/lib/factors/registry";
import { ENV_FACTORS } from "@/lib/factors/env";
import { MACRO_FACTORS } from "@/lib/factors/macro";
import { TECH_FACTORS } from "@/lib/factors/tech";
import { FUND_FACTORS } from "@/lib/factors/fund";
import { FILTER_FACTORS } from "@/lib/factors/filters";
import { SECTOR_FACTORS } from "@/lib/factors/sectors";
import { RISK_FACTORS } from "@/lib/factors/risk";
import { CAPITAL_FACTORS } from "@/lib/factors/capital";
import { CYCLE_FACTORS } from "@/lib/factors/cycle";
import { STRUCTURE_FACTORS } from "@/lib/factors/structure";
import { VALUATION_FACTORS } from "@/lib/factors/valuation";
import { SW_MAINLINE_FACTORS } from "@/lib/factors/sw-mainline";

export const ALL_FACTORS: FactorSpec<any>[] = [
  ...ENV_FACTORS, ...MACRO_FACTORS, ...TECH_FACTORS,
  ...FUND_FACTORS, ...FILTER_FACTORS, ...SECTOR_FACTORS, ...RISK_FACTORS, ...CAPITAL_FACTORS,
  ...CYCLE_FACTORS, ...STRUCTURE_FACTORS, ...VALUATION_FACTORS, ...SW_MAINLINE_FACTORS,
];

export function createDefaultRegistry() {
  return createRegistry(ALL_FACTORS);
}

/**
 * 默认注册表：模块加载时构建一次，之后不再改动 —— 注册表内部的 Map 是可变的，
 * 但这个实例从构建完成起就是只读使用。要往里加因子的调用方应当自己
 * createDefaultRegistry()，别往共享实例上挂，否则回测与实盘会看到不同的因子集。
 */
export const defaultRegistry = createDefaultRegistry();

export { createRegistry, runFactor, checkLock } from "@/lib/factors/registry";
export type { LockCheck } from "@/lib/factors/registry";

export {
  wasSt, isFirstListingDay, limitUpThreshold, judgeBarLimitUp, judgeBarLimitDown,
  limitUpCodes, limitDownCodes, proxyLbc, DEFAULT_LIMIT_THRESHOLDS,
} from "@/lib/factors/limit-up";
export type { LimitThresholds, LimitJudgement, ScanResult } from "@/lib/factors/limit-up";

export { marketBreadth, ENV_FACTORS } from "@/lib/factors/env";
export type { Breadth } from "@/lib/factors/env";

export { MACRO_FACTORS, DEFAULT_MACRO_SYMBOLS, DEFAULT_MACRO_WEIGHTS } from "@/lib/factors/macro";

export { bollinger, ma, TECH_FACTORS } from "@/lib/factors/tech";
export type { Bands } from "@/lib/factors/tech";

export {
  aggregateLhbByCode, dedupeSeats, classifySeat, lhbFlows, FUND_FACTORS,
} from "@/lib/factors/fund";
export type { CodeFlow, LhbRowPolicy, SeatKind } from "@/lib/factors/fund";

export {
  runFilters, DEFAULT_FILTER_PARAMS, FILTER_NAMES, UNSUPPORTED_FILTERS, FILTER_FACTORS,
} from "@/lib/factors/filters";
export type { FilterParams, FilterOutcome, FilterReport, FilterName } from "@/lib/factors/filters";

export {
  必查链, 必查链关键词, chainOf, identifyMainlines, SECTOR_FACTORS,
} from "@/lib/factors/sectors";
export type { MainlineHit, MainlineResult, MainlineOpts } from "@/lib/factors/sectors";

export { RISK_FACTORS, rsi, bias, kdj, tdxSma } from "@/lib/factors/risk";

export { CAPITAL_FACTORS } from "@/lib/factors/capital";
export { CYCLE_FACTORS } from "@/lib/factors/cycle";
export { sentimentSnapshot, percentileRank, SENTIMENT_ALGO_VERSION, LBC_CAP } from "@/lib/factors/sentiment";
export type { SentimentSnapshot } from "@/lib/factors/sentiment";
export {
  STRUCTURE_FACTORS, ema, macd, crosses, atr, pivots, structureLevels, doublePattern,
} from "@/lib/factors/structure";
export type { Macd, CrossEvent, Pivot, DoublePattern } from "@/lib/factors/structure";
export { VALUATION_FACTORS } from "@/lib/factors/valuation";
