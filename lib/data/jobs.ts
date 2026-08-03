import type { Db } from "@/lib/db";
import type { SourceClient } from "@/lib/data/client";
import { ensureTradingDay, syncCalendar } from "@/lib/data/calendar";
import { collectMarketSnapshot } from "@/lib/data/collectors/market-snapshot";
import { collectWatchMinute } from "@/lib/data/collectors/watch-minute";
import { collectZtPool } from "@/lib/data/collectors/cross-section";
import { collectDaily } from "@/lib/data/collectors/daily";
import { collectLhb } from "@/lib/data/collectors/lhb";
import { coverageReport, detectGaps } from "@/lib/data/gap";
import { backfillRecoverable } from "@/lib/data/backfill";
import { systemStartDate } from "@/lib/data/meta";

export type JobName = "selfcheck" | "preopen" | "intraday" | "close" | "post" | "night";

export interface JobDeps {
  db: Db;
  clients: { sina: SourceClient; tencent: SourceClient; eastmoney: SourceClient };
  now: Date;
}

export interface JobResult {
  name: string; skipped: boolean; reason?: string;
  stats: Record<string, number>;
  /** 缺口统计的起算日（系统起始日） */
  since?: string;
}

const KNOWN: JobName[] = ["selfcheck", "preopen", "intraday", "close", "post", "night"];

/** 用 Asia/Shanghai 取交易日，避免 UTC 偏移把 15:05 算到前一天 */
function shanghaiDate(now: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(now);
}

function allCodes(db: Db): string[] {
  return db.prepare(
    "SELECT code FROM security WHERE delist_date IS NULL ORDER BY code"
  ).all().map((r: any) => r.code);
}

/**
 * 关注池。M0 阶段观察池尚未建表，先取快照中出现过的前 50 只做占位。
 * M1 引入 watchpool 表后替换这里。
 */
function watchCodes(db: Db): string[] {
  return db.prepare(
    "SELECT DISTINCT code FROM quote_snapshot ORDER BY code LIMIT 50"
  ).all().map((r: any) => r.code);
}

export async function runJob(name: JobName, deps: JobDeps): Promise<JobResult> {
  if (!KNOWN.includes(name)) throw new Error(`unknown job: ${name}`);
  const { db, clients, now } = deps;
  const date = shanghaiDate(now);
  const compact = date.replace(/-/g, "");
  const stats: Record<string, number> = {};

  // 缺口一律从系统起始日算起，不把上线前的历史算成缺口
  const since = systemStartDate(db, date);

  if (name === "selfcheck") {
    Object.assign(stats, coverageReport(db, since, date));
    const gaps = detectGaps(db, since, date);
    stats.missingDailyDays = gaps.missingDaily.length;
    stats.missingZtPoolDays = gaps.missingZtPool.length;
    stats.missingLhbDays = gaps.missingLhb.length;
    return { name, skipped: false, stats, since };
  }

  // 日历缺当日记录时用实时行情兜底（当日日线收盘后才有）
  const isToday = date === shanghaiDate(new Date());
  if (!await ensureTradingDay(db, clients.tencent, date, isToday)) {
    return { name, skipped: true, reason: `${date} is not a trading day`, stats };
  }

  switch (name) {
    case "preopen": {
      stats.calendarRows = await syncCalendar(db, clients.sina, 60);
      break;
    }
    case "intraday": {
      const snap = await collectMarketSnapshot(db, clients.tencent, allCodes(db));
      stats.snapshotWritten = snap.written;
      stats.snapshotFailedBatches = snap.failedBatches;
      const wc = watchCodes(db);
      if (wc.length) {
        const min = await collectWatchMinute(db, clients.sina, wc, 5);
        stats.minuteWritten = min.written;
        stats.minuteFailed = min.failed.length;
      }
      break;
    }
    case "close": {
      const snap = await collectMarketSnapshot(db, clients.tencent, allCodes(db));
      stats.snapshotWritten = snap.written;
      stats.ztPoolRows = await collectZtPool(db, clients.eastmoney, compact);
      break;
    }
    case "post": {
      stats.lhbRows = await collectLhb(db, clients.eastmoney, date);
      break;
    }
    case "night": {
      const daily = await collectDaily(db, clients.sina, allCodes(db), 1023);
      stats.dailyWritten = daily.written;
      stats.dailyFailed = daily.failed.length;

      // 回补可回补的缺口（龙虎榜）；限量避免一次打爆限频
      const bf = await backfillRecoverable(db, clients.eastmoney, since, date, { maxDays: 10 });
      stats.backfillAttempted = bf.attempted.length;
      stats.backfillRecovered = bf.recovered.length;
      stats.backfillFailed = bf.failed.length;
      stats.unrecoverableGaps = bf.unrecoverable;
      break;
    }
  }
  return { name, skipped: false, stats };
}
