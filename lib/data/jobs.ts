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
import { deriveSecurityMeta } from "@/lib/data/security-meta";

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
  // 只取有日线序列的在市票。快照里含退市/PT 代码（000003 之类），
  // 它们在新浪没有分钟序列，抓了纯浪费请求，还会污染缺口统计
  return db.prepare(
    `SELECT s.code FROM security s
      WHERE s.delist_date IS NULL AND s.first_bar_date IS NOT NULL
        AND EXISTS (SELECT 1 FROM quote_snapshot q WHERE q.code = s.code)
      ORDER BY s.code LIMIT 50`
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

    // 调度覆盖率。今天该跑的时点跑了多少 —— 这个数字必须露在自检里：
    // 2026-08-05 合盖休眠导致 43 个盘中时点只采到 14 个，
    // 当时台账里有记录、但没人看得见，等于白记。
    const sched = db.prepare(
      `SELECT status, COUNT(*) n FROM job_run WHERE date = ? GROUP BY status`
    ).all(date) as Array<{ status: string; n: number }>;
    for (const r of sched) stats[`slots_${r.status}`] = r.n;
    const done = sched.find(r => r.status === "done")?.n ?? 0;
    const missed = sched.find(r => r.status === "missed")?.n ?? 0;
    const failed = sched.find(r => r.status === "failed")?.n ?? 0;
    const total = done + missed + failed;
    // 漏采的时点多半是机器睡了。快照与分钟线不可回补，缺了就是永久缺
    stats.slotCoverage = total === 0 ? 1 : Number((done / total).toFixed(4));
    const gaps = detectGaps(db, since, date);
    stats.missingDailyDays = gaps.missingDaily.length;
    stats.missingZtPoolDays = gaps.missingZtPool.length;
    stats.missingLhbDays = gaps.missingLhb.length;
    return { name, skipped: false, stats, since };
  }

  // preopen 只同步交易日历，休市日跑一次也无害。
  // 更重要的是：它必须在"还判不出今天是否开市"的时候也照跑 ——
  // 日历本来就是靠它补上的，被交易日门槛挡住就成了死锁（2026-08-04 就是这么丢了一上午）。
  if (name === "preopen") {
    stats.calendarRows = await syncCalendar(db, clients.sina, 60);
    return { name, skipped: false, stats };
  }

  // 日历缺当日记录时用实时行情兜底（当日日线收盘后才有）
  const isToday = date === shanghaiDate(new Date());
  if (!await ensureTradingDay(db, clients.tencent, date, isToday, now)) {
    return { name, skipped: true, reason: `${date} is not a trading day`, stats };
  }

  switch (name) {
    case "intraday": {
      const snap = await collectMarketSnapshot(db, clients.tencent, allCodes(db));
      stats.snapshotWritten = snap.written;
      stats.snapshotFailedBatches = snap.failedBatches;
      const wc = watchCodes(db);
      if (wc.length) {
        const min = await collectWatchMinute(db, clients.sina, wc, 5);
        stats.minuteWritten = min.written;
        stats.minuteFailed = min.failed.length;
        stats.minuteNoData = min.noData.length;
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
      // 源上无 K 线序列的代码（新股/定向转让），不是缺口但要能看见数量变化
      stats.dailyNoData = daily.noData.length;

      // 日线刚更新完，紧接着刷新上市日/ST 观测。
      // 新股每天在增加，它们的序列还没触顶，今天推不出来明天也推不出来
      const meta = deriveSecurityMeta(db);
      stats.listDateResolved = meta.listDateResolved;
      stats.stObserved = meta.stObserved;

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
