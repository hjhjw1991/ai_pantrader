import type { Db } from "@/lib/db";

export function recordGap(
  db: Db, date: string, source: string, kind: string,
  reason: string, recoverable: boolean
): void {
  db.prepare(
    `INSERT INTO data_gap (date, source, kind, reason, recoverable, detected_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(date, source, kind) DO UPDATE SET
       reason = excluded.reason, detected_at = excluded.detected_at, resolved_at = NULL`
  ).run(date, source, kind, reason, recoverable ? 1 : 0, new Date().toISOString());
}

export function resolveGap(db: Db, date: string, source: string, kind: string): void {
  db.prepare(
    `UPDATE data_gap SET resolved_at = ? WHERE date = ? AND source = ? AND kind = ?`
  ).run(new Date().toISOString(), date, source, kind);
}

/** 以 Asia/Shanghai 计的今天，避免 UTC 偏移把收盘后的时间算到前一天 */
export function today(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());
}
