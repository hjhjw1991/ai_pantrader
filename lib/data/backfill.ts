import type { Db } from "@/lib/db";
import type { SourceClient } from "@/lib/data/client";
import { detectGaps } from "@/lib/data/gap";
import { collectLhb } from "@/lib/data/collectors/lhb";

export interface BackfillReport {
  attempted: string[];
  recovered: string[];
  failed: Array<{ date: string; error: string }>;
  unrecoverable: number;
}

/**
 * 只回补可回补的数据（龙虎榜）。
 * 日线的回补由 night job 的 collectDaily 全量拉取覆盖，不在此重复。
 * 分钟线/涨停池/板块榜不可回补，只统计数量供告警用。
 */
export async function backfillRecoverable(
  db: Db, client: SourceClient, from: string, to: string,
  o: { maxDays?: number } = {}
): Promise<BackfillReport> {
  const gaps = detectGaps(db, from, to);
  const limit = o.maxDays ?? Number.POSITIVE_INFINITY;
  const attempted = gaps.missingLhb.slice(0, limit === Number.POSITIVE_INFINITY
    ? gaps.missingLhb.length : limit);
  const recovered: string[] = [];
  const failed: Array<{ date: string; error: string }> = [];

  for (const date of attempted) {
    try {
      await collectLhb(db, client, date);
      recovered.push(date);
    } catch (e: any) {
      failed.push({ date, error: e?.message ?? String(e) });
    }
  }

  const un = db.prepare(
    `SELECT COUNT(*) n FROM data_gap
     WHERE resolved_at IS NULL AND recoverable = 0 AND date >= ? AND date <= ?`
  ).get(from, to) as any;

  return { attempted, recovered, failed, unrecoverable: un.n };
}
