import type { Db } from "@/lib/db";
import type { SourceClient } from "@/lib/data/client";
import { ensureTradingDay, syncCalendar, tradingDaysBetween } from "@/lib/data/calendar";
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
 * 龙虎榜的 D1/D5/D10/D20/D30 后续涨跌幅是上榜当日拿不到的（全为 null），
 * 由东财随时间回填。这些字段是自校准闭环的监督标签，必须回头重拉才能拿到。
 *
 * 不做"滚动重拉最近 30 天"—— 那是 30 天 × 3 请求 = 90 次，实测东财十几次就限流。
 * 只在标签真正落地的那几个偏移量上重拉：t+1 / t+5 / t+10 / t+20 / t+30。
 *
 * 偏移量 0 = 当日重拉：龙虎榜是逐步发布的，实测 2026-08-03 17:00 只有 35 行、
 * 18:50 已有 58 行。post job 拿的只是快照，night job 必须再抓一次收尾。
 */
export const LHB_LABEL_OFFSETS = [0, 1, 5, 10, 20, 30];

/** 返回今天应当重拉的历史交易日（去重、升序）。 */
export function lhbRefreshDates(db: Db, since: string, today: string): string[] {
  // 往前多取一些日历天，保证 30 个交易日的偏移能取到
  const from = new Date(Date.parse(`${today}T00:00:00Z`) - 70 * 86400_000)
    .toISOString().slice(0, 10);
  const days = tradingDaysBetween(db, from < since ? since : from, today);
  const idxToday = days.lastIndexOf(today);
  // 日历还没记录今天时，以最后一个交易日为基准
  const base = idxToday >= 0 ? idxToday : days.length - 1;
  if (base < 0) return [];

  const out = new Set<string>();
  for (const off of LHB_LABEL_OFFSETS) {
    const i = base - off;
    if (i >= 0) out.add(days[i]);
  }
  return [...out].sort();
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
      const lhb = await collectLhb(db, clients.eastmoney, date);
      stats.lhbRows = lhb.stored;
      stats.lhbSeatRows = lhb.seatsStored;
      break;
    }
    case "night": {
      const daily = await collectDaily(db, clients.sina, allCodes(db), 1023);
      stats.dailyWritten = daily.written;
      stats.dailyFailed = daily.failed.length;

      // 重拉历史龙虎榜，把随时间回填的 D1..D30 标签取回来
      let refreshed = 0, refreshFailed = 0;
      for (const d of lhbRefreshDates(db, since, date)) {
        try {
          await collectLhb(db, clients.eastmoney, d);
          refreshed++;
        } catch {
          // 失败已由 collectLhb 记成 recoverable gap，交给下面的回补流程
          refreshFailed++;
        }
      }
      stats.lhbRefreshed = refreshed;
      stats.lhbRefreshFailed = refreshFailed;

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
