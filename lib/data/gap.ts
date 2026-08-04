import type { Db } from "@/lib/db";
import { tradingDaysBetween } from "@/lib/data/calendar";
import { shanghaiTs } from "@/lib/data/clock";

export function recordGap(
  db: Db, date: string, source: string, kind: string,
  reason: string, recoverable: boolean
): void {
  db.prepare(
    `INSERT INTO data_gap (date, source, kind, reason, recoverable, detected_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(date, source, kind) DO UPDATE SET
       reason = excluded.reason, detected_at = excluded.detected_at, resolved_at = NULL`
  ).run(date, source, kind, reason, recoverable ? 1 : 0, shanghaiTs());
}

export function resolveGap(db: Db, date: string, source: string, kind: string): void {
  db.prepare(
    `UPDATE data_gap SET resolved_at = ? WHERE date = ? AND source = ? AND kind = ?`
  ).run(shanghaiTs(), date, source, kind);
}

/** 以 Asia/Shanghai 计的今天，避免 UTC 偏移把收盘后的时间算到前一天 */
export function today(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());
}

export interface GapReport {
  missingDaily: string[];
  missingZtPool: string[];
  missingLhb: string[];
}

function daysMissingFrom(db: Db, table: string, days: string[]): string[] {
  if (days.length === 0) return [];
  const present = new Set(
    db.prepare(
      `SELECT DISTINCT date FROM ${table} WHERE date >= ? AND date <= ?`
    ).all(days[0], days[days.length - 1]).map((r: any) => r.date)
  );
  return days.filter(d => !present.has(d));
}

export function detectGaps(db: Db, from: string, to: string): GapReport {
  const days = tradingDaysBetween(db, from, to);
  return {
    missingDaily: daysMissingFrom(db, "kline_daily", days),
    missingZtPool: daysMissingFrom(db, "zt_pool", days),
    missingLhb: daysMissingFrom(db, "lhb", days),
  };
}

export function coverageReport(db: Db, from: string, to: string): {
  tradingDays: number; daysWithZtPool: number; daysWithDaily: number; unresolvedGaps: number;
} {
  const days = tradingDaysBetween(db, from, to);
  const g = detectGaps(db, from, to);
  const unresolved = db.prepare(
    `SELECT COUNT(*) n FROM data_gap WHERE resolved_at IS NULL AND date >= ? AND date <= ?`
  ).get(from, to) as any;
  return {
    tradingDays: days.length,
    daysWithZtPool: days.length - g.missingZtPool.length,
    daysWithDaily: days.length - g.missingDaily.length,
    unresolvedGaps: unresolved.n,
  };
}
