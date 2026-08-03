import type { Db } from "@/lib/db";
import type { Action, ErrorType, Verdict } from "@/lib/contracts";
import { dateOf, predWhere, round, type EvalHorizon, type LedgerFilter } from "@/lib/ledger/query";
import { directionOf, type Direction } from "@/lib/ledger/reconcile";
import { ERROR_TYPES, winRate, type LedgerWinRateStats } from "@/lib/ledger/winrate";

/**
 * 胜率仪表盘的聚合查询层（spec §11 第 5 步、§13 前端）。
 *
 * 前端只读这里的返回类型，不自己写 SQL —— 否则同一个"胜率"会有两套口径。
 * 分母口径与 winrate.ts 一致：只算有方向的判定，中性单独计数。
 */

export type Granularity = "day" | "week" | "month";

export interface PeriodHitRate {
  /** day: 2026-08-03 / week: 该周周一 / month: 2026-08 */
  period: string;
  total: number;
  hit: number;
  miss: number;
  neutral: number;
  /** total 为 0 时给 null，让前端显示"—"而不是 0% */
  rate: number | null;
}

export interface StockHitRate {
  code: string;
  name: string | null;
  total: number;
  hit: number;
  neutral: number;
  rate: number | null;
  /** 已结算样本的平均实际涨跌幅（%），含中性 */
  avgActualPct: number | null;
}

export interface ErrorTypeCount {
  errorType: ErrorType;
  count: number;
  /** 占全部已归因错误的比例；分母为 0 时给 0 */
  share: number;
}

export interface TimelinePoint {
  predId: string;
  ts: string;
  date: string;
  code: string;
  phase: string;
  action: Action;
  expectedDirection: Direction;
  triggerPx: number | null;
  stopPx: number | null;
  evalHorizon: EvalHorizon;
  validUntil: string;
  advisorInfluenced: boolean;
  settled: boolean;
  verdict: Verdict | null;
  /** 未结算时为 null —— 不拿当前浮盈冒充结算结果 */
  actualPct: number | null;
  errorType: ErrorType | null;
  settledAt: string | null;
  attribution: string | null;
}

export interface PendingSummary {
  pending: number;
  /** 已过 valid_until 却还没结算的：多半是缺价，要人看 */
  overdueUnsettled: number;
  settled: number;
}

export interface LedgerDashboard {
  asOf: string;
  overall: LedgerWinRateStats;
  byPeriod: PeriodHitRate[];
  byStock: StockHitRate[];
  byErrorType: ErrorTypeCount[];
  timeline: TimelinePoint[];
  pending: PendingSummary;
}

/** 该日期所在周的周一（ISO 周起点），用作周分组键 */
function mondayOf(date: string): string {
  const t = Date.parse(`${date}T00:00:00Z`);
  const dow = new Date(t).getUTCDay();          // 0=周日
  const back = (dow + 6) % 7;
  return new Date(t - back * 86400_000).toISOString().slice(0, 10);
}

function periodKey(date: string, g: Granularity): string {
  if (g === "month") return date.slice(0, 7);
  if (g === "week") return mondayOf(date);
  return date;
}

interface JoinRow {
  ts: string; code: string; verdict: Verdict; actual_pct: number | null;
}

function joinRows(db: Db, filter: LedgerFilter): JoinRow[] {
  const w = predWhere(filter);
  return db.prepare(
    `SELECT p.ts, p.code, o.verdict, o.actual_pct
     FROM prediction p JOIN outcome o ON o.pred_id = p.id
     WHERE 1=1${w.sql} ORDER BY p.ts`
  ).all(...w.params) as JoinRow[];
}

export function hitRateByPeriod(
  db: Db, opts: LedgerFilter & { granularity?: Granularity } = {}
): PeriodHitRate[] {
  const { granularity = "day", ...filter } = opts;
  const acc = new Map<string, PeriodHitRate>();
  for (const r of joinRows(db, filter)) {
    const key = periodKey(dateOf(r.ts), granularity);
    const cur = acc.get(key)
      ?? { period: key, total: 0, hit: 0, miss: 0, neutral: 0, rate: null };
    if (r.verdict === "中性") cur.neutral++;
    else {
      cur.total++;
      if (r.verdict === "命中") cur.hit++; else cur.miss++;
    }
    acc.set(key, cur);
  }
  return [...acc.values()]
    .map(r => ({ ...r, rate: r.total ? round(r.hit / r.total, 6) : null }))
    .sort((a, b) => a.period.localeCompare(b.period));
}

export function hitRateByStock(db: Db, filter: LedgerFilter = {}): StockHitRate[] {
  const names = new Map<string, string | null>(
    db.prepare("SELECT code, name FROM security").all()
      .map((r: any) => [r.code as string, (r.name ?? null) as string | null])
  );
  const acc = new Map<string, StockHitRate & { pctSum: number; pctN: number }>();
  for (const r of joinRows(db, filter)) {
    const cur = acc.get(r.code) ?? {
      code: r.code, name: names.get(r.code) ?? null,
      total: 0, hit: 0, neutral: 0, rate: null, avgActualPct: null, pctSum: 0, pctN: 0,
    };
    if (r.verdict === "中性") cur.neutral++;
    else { cur.total++; if (r.verdict === "命中") cur.hit++; }
    if (r.actual_pct != null) { cur.pctSum += r.actual_pct; cur.pctN++; }
    acc.set(r.code, cur);
  }
  return [...acc.values()]
    .map(({ pctSum, pctN, ...s }) => ({
      ...s,
      rate: s.total ? round(s.hit / s.total, 6) : null,
      avgActualPct: pctN ? round(pctSum / pctN, 6) : null,
    }))
    // 样本多的排前面：只结算过 1 条的票的"100% 胜率"没有参考价值
    .sort((a, b) => (b.total + b.neutral) - (a.total + a.neutral) || a.code.localeCompare(b.code));
}

/** 五类键永远齐全，0 也返回 —— "这类一次都没发生"本身是信息 */
export function errorTypeBreakdown(db: Db, filter: LedgerFilter = {}): ErrorTypeCount[] {
  const w = predWhere(filter);
  const rows = db.prepare(
    `SELECT o.error_type et, COUNT(*) n
     FROM prediction p JOIN outcome o ON o.pred_id = p.id
     WHERE o.error_type IS NOT NULL${w.sql} GROUP BY o.error_type`
  ).all(...w.params) as Array<{ et: ErrorType; n: number }>;

  const counts = new Map(rows.map(r => [r.et, r.n]));
  const totalN = rows.reduce((s, r) => s + r.n, 0);
  return ERROR_TYPES
    .map(et => ({
      errorType: et,
      count: counts.get(et) ?? 0,
      share: totalN ? round((counts.get(et) ?? 0) / totalN, 6) : 0,
    }))
    .sort((a, b) => b.count - a.count);
}

/**
 * 预测 vs 实际时间线。已结算与未结算放在同一条轴上：
 * 只看已结算等于事后挑样本，未结算的那些（尤其缺价卡住的）也必须露出来。
 */
export function predictionTimeline(
  db: Db, opts: LedgerFilter & { limit?: number } = {}
): TimelinePoint[] {
  const { limit, ...filter } = opts;
  const w = predWhere(filter);
  const rows = db.prepare(
    `SELECT p.id, p.ts, p.code, p.phase, p.action, p.trigger_px, p.stop_px,
            p.eval_horizon, p.valid_until, p.advisor_influenced,
            o.verdict, o.actual_pct, o.error_type, o.settled_at, o.attribution
     FROM prediction p LEFT JOIN outcome o ON o.pred_id = p.id
     WHERE 1=1${w.sql}
     ORDER BY p.ts, p.id${limit ? " LIMIT " + Number(limit) : ""}`
  ).all(...w.params) as any[];

  return rows.map(r => ({
    predId: r.id,
    ts: r.ts,
    date: dateOf(r.ts),
    code: r.code,
    phase: r.phase,
    action: r.action as Action,
    expectedDirection: directionOf(r.action as Action),
    triggerPx: r.trigger_px,
    stopPx: r.stop_px,
    evalHorizon: r.eval_horizon as EvalHorizon,
    validUntil: r.valid_until,
    advisorInfluenced: r.advisor_influenced === 1,
    settled: r.verdict != null,
    verdict: (r.verdict ?? null) as Verdict | null,
    actualPct: r.actual_pct ?? null,
    errorType: (r.error_type ?? null) as ErrorType | null,
    settledAt: r.settled_at ?? null,
    attribution: r.attribution ?? null,
  }));
}

export function pendingSummary(db: Db, asOf: string, filter: LedgerFilter = {}): PendingSummary {
  const w = predWhere(filter);
  const row = db.prepare(
    `SELECT
       SUM(CASE WHEN o.pred_id IS NULL THEN 1 ELSE 0 END) pending,
       SUM(CASE WHEN o.pred_id IS NULL AND p.valid_until <= ? THEN 1 ELSE 0 END) overdue,
       SUM(CASE WHEN o.pred_id IS NOT NULL THEN 1 ELSE 0 END) settled
     FROM prediction p LEFT JOIN outcome o ON o.pred_id = p.id
     WHERE 1=1${w.sql}`
  ).get(asOf, ...w.params) as any;
  return {
    pending: row?.pending ?? 0,
    overdueUnsettled: row?.overdue ?? 0,
    settled: row?.settled ?? 0,
  };
}

export function ledgerDashboard(
  db: Db,
  opts: LedgerFilter & { asOf?: string; granularity?: Granularity; timelineLimit?: number } = {}
): LedgerDashboard {
  const { asOf, granularity = "day", timelineLimit, ...filter } = opts;
  const at = asOf ?? new Date().toISOString().slice(0, 10);
  return {
    asOf: at,
    overall: winRate(db, filter),
    byPeriod: hitRateByPeriod(db, { ...filter, granularity }),
    byStock: hitRateByStock(db, filter),
    byErrorType: errorTypeBreakdown(db, filter),
    timeline: predictionTimeline(db, { ...filter, limit: timelineLimit }),
    pending: pendingSummary(db, at, filter),
  };
}
