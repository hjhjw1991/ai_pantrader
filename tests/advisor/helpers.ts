import type { PointInTimeView } from "@/lib/contracts/pit";
import type { AdvisorInput } from "@/lib/contracts/advisor";
import type { Candidate, EnvAssessment } from "@/lib/contracts/strategy";

/** 只做 asOf 有意义的假视图：Advisor 只读 asOf + env + candidates，不查数据。 */
export function fakeView(asOf: string): PointInTimeView {
  const notUsed = () => {
    throw new Error("advisor 层不应访问 PointInTimeView 的数据方法");
  };
  return {
    asOf,
    dailyBars: notUsed,
    minuteBars: notUsed,
    quote: notUsed,
    ztPool: notUsed,
    dtPool: notUsed,
    sectorRank: notUsed,
    lhb: notUsed,
    lhbSeats: notUsed,
    macro: notUsed,
    universe: notUsed,
    security: notUsed,
    tradingDays: notUsed,
    prevTradingDay: notUsed,
    hasGap: notUsed,
  } as unknown as PointInTimeView;
}

export function makeEnv(over: Partial<EnvAssessment> = {}): EnvAssessment {
  return {
    gear: "中性",
    targetPosition: 0.5,
    reasons: ["涨停家数中位"],
    factors: [],
    lowConfidenceFactors: [],
    ...over,
  };
}

export function makeCandidate(over: Partial<Candidate> = {}): Candidate {
  return {
    code: "600123",
    name: "测试股",
    action: "买入",
    account: "卫星",
    triggerPx: 10,
    stopPx: 9,
    size: 0.1,
    thesis: "主线回踩",
    passedFilters: ["量能"],
    factors: [],
    score: 0.6,
    ...over,
  };
}

export function makeInput(over: { asOf?: string; env?: EnvAssessment; candidates?: Candidate[] } = {}): AdvisorInput {
  return {
    view: fakeView(over.asOf ?? "2026-08-03T09:15:00+08:00"),
    env: over.env ?? makeEnv(),
    candidates: over.candidates ?? [makeCandidate()],
  };
}
