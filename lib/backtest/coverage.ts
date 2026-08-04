import type { CoverageReport } from "@/lib/contracts";
import { TRADING_DAYS_PER_YEAR } from "@/lib/backtest/metrics";

/**
 * 回测报告首页必含项（spec §10.5）：覆盖率 · gap 日数 · 低置信因子 · 有效区间。
 *
 * 这四项不是装饰。一份写着"年化 40%"但没写"其中 19 个月没有复权参照、覆盖率 71%、
 * 情绪因子 ρ=0.61"的报告，是在骗自己。
 *
 * 最容易被含糊掉的是**有效区间**：请求 2022-01~2026-08 看着是 4.6 年，
 * 但 spec R1 的复权断层（2022-05~2023-12 无复权参照）让这段区间的除权票失真，
 * 诚实的有效区间只有 2024-01 至今约 2.6 年。所以这里的 effectiveRange 永远从
 * 断层之后起算，除非调用方明确声明断层已解决（adjFactorResolved）。
 */

/** spec R1：这段区间无复权参照。攻下 SINA klc_kl.js 之前，回测有效区间从它之后起算 */
export const ADJ_FACTOR_GAP = { from: "2022-05-01", to: "2023-12-31" } as const;

/**
 * 断层之后的第一个自然日。写成常量而不是用 Date 算出来 ——
 * 回测目录里一个 new Date/Date.now 都不该出现，否则可复现性断言（spec §17-4）的
 * 静态检查就得给例外，例外一开就守不住了。
 */
export const ADJ_FACTOR_FLOOR = "2024-01-01";

/** ρ 低于此值的代理因子要在报告首页标红（spec §10.3） */
export const LOW_CONFIDENCE_RHO = 0.8;

export interface CoverageInput {
  requested: { from: string; to: string };
  /** 请求区间内日历应有的交易日 */
  tradingDays: string[];
  /** 实际完成回放的交易日 */
  replayedDays: string[];
  /** 因数据缺口被跳过的交易日（spec §10.5：跳过并计数，绝不插值） */
  skippedDays: string[];
  /** proxy-audit 的产出，全部因子都可以传进来，这里只留 ρ<0.8 的 */
  lowConfidenceFactors?: Array<{ name: string; rho: number }>;
  /** R1 攻下来了才传 true。默认 false = 诚实缩区间 */
  adjFactorResolved?: boolean;
}

export interface CoverageReportDetail extends CoverageReport {
  requestedRange: { from: string; to: string };
  /** 因复权断层被砍掉的交易日数 */
  truncatedDays: number;
  /** 有效区间折算的年数，按 252 交易日/年 */
  effectiveYears: number;
  /** 首页要照抄的提示语 */
  notes: string[];
}

export function buildCoverageReport(i: CoverageInput): CoverageReportDetail {
  const notes: string[] = [];

  // 有效起点：复权断层之后
  const adjFloor = i.adjFactorResolved ? i.requested.from : maxStr(i.requested.from, ADJ_FACTOR_FLOOR);
  const effectiveCalendar = i.tradingDays.filter((d) => d >= adjFloor && d <= i.requested.to);
  const truncatedDays = i.tradingDays.filter((d) => d >= i.requested.from && d < adjFloor).length;

  const replayedInRange = i.replayedDays.filter((d) => d >= adjFloor && d <= i.requested.to).sort();
  const coverage = effectiveCalendar.length === 0 ? 0 : replayedInRange.length / effectiveCalendar.length;

  const effectiveRange = replayedInRange.length === 0
    ? { from: "", to: "" }
    : { from: replayedInRange[0], to: replayedInRange[replayedInRange.length - 1] };

  const effectiveYears = effectiveCalendar.length === 0
    ? 0
    : countBetween(i.tradingDays, effectiveRange.from, effectiveRange.to) / TRADING_DAYS_PER_YEAR;

  if (truncatedDays > 0) {
    notes.push(
      `复权断层（spec R1）：${ADJ_FACTOR_GAP.from}~${ADJ_FACTOR_GAP.to} 无复权参照，` +
      `有效区间已从请求的 ${i.requested.from} 缩到 ${effectiveRange.from || adjFloor}，` +
      `砍掉 ${truncatedDays} 个交易日 —— 报告里的指标只对有效区间成立。`
    );
  }
  if (i.skippedDays.length > 0) {
    notes.push(`${i.skippedDays.length} 个交易日因数据缺口被跳过（不插值，spec §10.5）。`);
  }
  if (coverage < 1 && effectiveCalendar.length > 0) {
    notes.push(`有效区间覆盖率 ${(coverage * 100).toFixed(2)}%，缺失 ${effectiveCalendar.length - replayedInRange.length} 天。`);
  }
  if (effectiveYears > 0 && effectiveYears < 1) {
    notes.push(`有效区间 ${effectiveYears.toFixed(2)} 年不足一年，年化与 Calmar 不可信（见 metrics 退化标记）。`);
  }
  if (effectiveCalendar.length === 0 || replayedInRange.length === 0) {
    notes.push("有效区间内没有任何可回放的交易日，本报告的指标全部无意义。");
  }

  const lowConfidenceFactors = (i.lowConfidenceFactors ?? [])
    .filter((f) => f.rho < LOW_CONFIDENCE_RHO)
    .sort((a, b) => a.rho - b.rho)
    .map((f) => ({ name: f.name, rho: f.rho }));
  if (lowConfidenceFactors.length > 0) {
    notes.push(
      `低置信代理因子 ${lowConfidenceFactors.length} 个（ρ<${LOW_CONFIDENCE_RHO}）：` +
      lowConfidenceFactors.map((f) => `${f.name} ρ=${f.rho}`).join("、")
    );
  }

  return {
    coverage,
    gapDays: i.skippedDays.length,
    lowConfidenceFactors,
    effectiveRange,
    requestedRange: { ...i.requested },
    truncatedDays,
    effectiveYears,
    notes,
  };
}

/** 报告首页那一块文本。刻意把请求区间和有效区间并列，让缩水一眼可见 */
export function formatCoverageHeader(r: CoverageReportDetail): string {
  const lines = [
    `请求区间：${r.requestedRange.from} ~ ${r.requestedRange.to}`,
    `有效区间：${r.effectiveRange.from || "—"} ~ ${r.effectiveRange.to || "—"}（${r.effectiveYears.toFixed(2)} 年）`,
    `数据覆盖率：${(r.coverage * 100).toFixed(2)}%　gap 日：${r.gapDays} 天　复权断层砍掉：${r.truncatedDays} 天`,
    r.lowConfidenceFactors.length === 0
      ? "低置信因子：无"
      : `低置信因子：${r.lowConfidenceFactors.map((f) => `${f.name} (ρ=${f.rho})`).join("、")}`,
  ];
  for (const n of r.notes) lines.push(`· ${n}`);
  return lines.join("\n");
}

function maxStr(a: string, b: string): string {
  return a >= b ? a : b;
}

function countBetween(days: string[], from: string, to: string): number {
  if (!from || !to) return 0;
  return days.filter((d) => d >= from && d <= to).length;
}
