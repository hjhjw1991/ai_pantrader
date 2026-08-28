import type { Db } from "@/lib/db";
import type { SourceClient } from "@/lib/data/client";
import { ensureTradingDay, syncCalendar, tradingDaysBetween } from "@/lib/data/calendar";
import { collectMarketSnapshot } from "@/lib/data/collectors/market-snapshot";
import { collectWatchMinute } from "@/lib/data/collectors/watch-minute";
import {
  collectZtPool, collectSectorRank, collectDtPool, collectMacro,
  collectSectorMembers, sectorMembersUpdatedAt, collectSectorRankList,
} from "@/lib/data/collectors/cross-section";
import { collectDaily, collectIndexDaily } from "@/lib/data/collectors/daily";
import { INDICES } from "@/lib/data/indices";
import { collectLhb } from "@/lib/data/collectors/lhb";
import { coverageReport, detectGaps } from "@/lib/data/gap";
import { backfillRecoverable } from "@/lib/data/backfill";
import { systemStartDate } from "@/lib/data/meta";
import { refreshTableCounts } from "@/lib/data/table-counts";
import { deriveSecurityMeta } from "@/lib/data/security-meta";
import { MACRO_SECIDS } from "@/lib/data/sources/eastmoney";
import { shanghaiTs } from "@/lib/data/clock";

/**
 * 盘中每隔多少分钟采一次板块涨幅榜。盘中时点是 5 分钟一个，所以 15 = 每 3 轮一次。
 * 设 0 表示盘中完全不采（只留收盘那一张）。
 */
const SECTOR_RANK_EVERY_MIN = 15;

/**
 * 代码→行业 映射多久刷新一次（天）。
 *
 * 刷一次要 100+ 个请求，是本项目对东财最重的调用；而行业归属只在并购、
 * 主业变更时才动。所以按周刷，且只在夜间 —— 那时没人等结果，
 * 限流也影响不到盘中采集。
 */
const SECTOR_MEMBERS_MAX_AGE_DAYS = 7;

export type JobName =
  | "selfcheck" | "preopen" | "plan" | "intraday" | "close" | "post" | "night";

export interface JobDeps {
  db: Db;
  clients: { sina: SourceClient; tencent: SourceClient; eastmoney: SourceClient };
  now: Date;
  /**
   * 批次级进度回调，可选。只有手动采集（页面按钮）会传 ——
   * 一轮全市场约 45 秒，不报进度用户只能盯着转圈猜是不是卡死了。
   * 定时任务不传：没人看着，回调只是白开销。
   */
  onProgress?: (p: JobProgress) => void;
  /**
   * 盘前作战计划的实现，由组装根注入（scripts/daemon.ts / scripts/job.ts）。
   *
   * 为什么是注入而不是直接 import：算计划要用 strategy/factors 和策略配置，
   * 那些都在 lib/data **之上**。lib/data 至今没有一处反向依赖上层，
   * 这条分层值得保住 —— 一旦破了口子，采集层就会慢慢长出对界面层的依赖。
   *
   * 没注入时 job 如实 skip 并说明原因，而不是静默当成"跑过了"。
   */
  planPreopen?: (db: Db) => Promise<{ ok: boolean; reason?: string; candidates: unknown[] }>;
  /**
   * 盘中信号盯守，同样由组装根注入（理由见 planPreopen）。
   * 每轮盘中采集之后重算信号卡并与上次比对，产生档位切换 / 新候选 / 硬线告警通知。
   */
  signalWatch?: (db: Db) => Promise<{ notified: number; reason?: string }>;
}

/** 进度事件。phase 是当前在做哪一步，done/total 是该步的批次进度 */
export interface JobProgress {
  phase: "snapshot" | "minute";
  done: number;
  total: number;
  written: number;
  failedBatches: number;
}

export interface JobResult {
  name: string; skipped: boolean; reason?: string;
  stats: Record<string, number>;
  /** 缺口统计的起算日（系统起始日） */
  since?: string;
}

const KNOWN: JobName[] = ["selfcheck", "preopen", "plan", "intraday", "close", "post", "night"];

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

/**
 * 判定一次 job 的真实成败。
 *
 * 为什么不能"没抛错就算成功"：采集器遇到批次失败时记 data_gap 后继续，
 * 不抛错 —— 这是刻意设计（一个批次挂了不该让整轮白跑）。
 * 于是 `snapshotWritten:0, snapshotFailedBatches:99` 这种全军覆没也会正常返回，
 * 台账把它记成 done，覆盖率就被凭空抬高。实测 2026-08-05 有两轮正是如此。
 *
 * 判据：**该写的一条都没写进去，就是失败**，不管有没有抛错。
 */
export function jobOutcome(
  name: JobName, stats: Record<string, number>
): { ok: boolean; reason?: string } {
  const wroteNothing = (wrote: string, failed: string) =>
    (stats[wrote] ?? 0) === 0 && (stats[failed] ?? 0) > 0;

  if (name === "intraday" || name === "close") {
    if (wroteNothing("snapshotWritten", "snapshotFailedBatches")) {
      return {
        ok: false,
        reason: `全市场快照 0 条写入、${stats.snapshotFailedBatches} 个批次失败（大概率限频）`,
      };
    }
  }
  if (name === "night" && wroteNothing("dailyWritten", "dailyFailed")) {
    return { ok: false, reason: `日线 0 条写入、${stats.dailyFailed} 只失败` };
  }
  if (name === "post" && (stats.lhbRows ?? -1) === 0) {
    // 龙虎榜真有可能当日为空（无票上榜），所以只在明确 0 且非交易日之外才提示，
    // 这里不判失败，只是不静默 —— 交给 selfcheck 的缺口统计
    return { ok: true };
  }
  return { ok: true };
}

export async function runJob(name: JobName, deps: JobDeps): Promise<JobResult> {
  if (!KNOWN.includes(name)) throw new Error(`unknown job: ${name}`);
  const { db, clients, now, onProgress, planPreopen, signalWatch } = deps;
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
    /**
     * 外围标的的隔夜读数。放在盘前而不是盘中：A 股开盘时美股已经收盘，
     * "外围传导"要的正是隔夜到盘前这一段的风险偏好，盘中再采只是重复同一个数。
     * 逐标的独立成败，缺一个由因子按权重覆盖率自行降权（见 lib/factors/macro.ts）。
     */
    {
      const m = await collectMacro(db, clients.eastmoney, Object.keys(MACRO_SECIDS));
      stats.macroWritten = m.written;
      stats.macroFailed = m.failed.length;
    }
    return { name, skipped: false, stats };
  }

  // 日历缺当日记录时用实时行情兜底（当日日线收盘后才有）
  const isToday = date === shanghaiDate(new Date());
  if (!await ensureTradingDay(db, clients.tencent, date, isToday, now)) {
    return { name, skipped: true, reason: `${date} is not a trading day`, stats };
  }

  switch (name) {
    case "plan": {
      if (planPreopen === undefined) {
        return { name, skipped: true,
          reason: "未注入盘前计划实现（组装根没接上 lib/plan/preopen）", stats };
      }
      const r = await planPreopen(db);
      stats.candidates = r.candidates.length;
      stats.planOk = r.ok ? 1 : 0;
      if (!r.ok) return { name, skipped: true, reason: r.reason ?? "计划未生成", stats };
      break;
    }
    case "intraday": {
      const snap = await collectMarketSnapshot(db, clients.tencent, allCodes(db),
        onProgress === undefined ? undefined : p => onProgress({ phase: "snapshot", ...p }));
      stats.snapshotWritten = snap.written;
      stats.snapshotFailedBatches = snap.failedBatches;
      const wc = watchCodes(db);
      if (wc.length) {
        const min = await collectWatchMinute(db, clients.sina, wc, 5);
        stats.minuteWritten = min.written;
        stats.minuteFailed = min.failed.length;
        stats.minuteNoData = min.noData.length;
      }
      /**
       * 板块涨幅榜。主线识别看的是"谁一直在榜上"，所以要留多个时点，
       * 但**不必每轮都留**：实测每 5 分钟一次会把东财打到限流 ——
       * 一轮下来 10 个主机多数返回 fetch failed，靠轮换才勉强拿到，
       * 而同一时段 tencent/sina 是 594/594、300/300 全成功。是我们打得太密。
       *
       * 每 15 分钟一次（每 3 个时点采一次）：盘中约 10 个时点快照，
       * 足够看出"谁一直在榜上"，而请求量降到三分之一。
       * 失败不上抛：板块榜没了不该让整轮盘中采集（全市场快照）算失败。
       */
      if (SECTOR_RANK_EVERY_MIN > 0) {
        const mins = Number(shanghaiTs(now).slice(14, 16));
        if (mins % SECTOR_RANK_EVERY_MIN < 5) {
          try {
            stats.sectorRankRows = await collectSectorRank(db, clients.eastmoney, compact);
          } catch { stats.sectorRankFailed = 1; }
        }
      }

      /**
       * 采完就比一次信号。放在这里而不是另起一个 job：
       * 通知要的是"数据刚变，结论跟着变了没有"，而数据正好是这一步刚写进去的。
       * 另起 job 既要重算一遍，还会和这一轮之间隔出一个不必要的时间差。
       */
      if (signalWatch !== undefined) {
        const w = await signalWatch(db);
        stats.notified = w.notified;
      }
      break;
    }
    case "close": {
      const snap = await collectMarketSnapshot(db, clients.tencent, allCodes(db));
      stats.snapshotWritten = snap.written;
      stats.ztPoolRows = await collectZtPool(db, clients.eastmoney, compact);
      // 跌停池与涨停池同源同节奏：都是当日现场，date 参数无效，错过就没有
      try {
        stats.dtPoolRows = await collectDtPool(db, clients.eastmoney, compact);
      } catch { stats.dtPoolFailed = 1; }
      // 收盘也留一张板块榜：当天最后一个时点，是"今天主线是谁"的定论。
      // 这次给足重试轮数 —— 盘中失败还有下一轮兜底，收盘失败就是永久没有
      try {
        stats.sectorRankRows = await collectSectorRank(db, clients.eastmoney, compact, { rounds: 3 });
      } catch { stats.sectorRankFailed = 1; }
      break;
    }
    case "post": {
      const lhb = await collectLhb(db, clients.eastmoney, date);
      stats.lhbRows = lhb.stored;
      stats.lhbSeatRows = lhb.seatsStored;
      break;
    }
    case "night": {
      /**
       * 代码→行业 映射：空表或过期才刷。放在夜间 job 的最前面 ——
       * 它请求重，跑在全量日线之前可以和后面那 5,888 次新浪请求错开源。
       */
      {
        const last = sectorMembersUpdatedAt(db);
        const lastMs = last === null ? NaN : Date.parse(`${last.slice(0, 10)}T00:00:00Z`);
        // 空表或时间戳解析不出来（脏数据）都当成"该刷了"：宁可多刷一次，
        // 也不要因为一个解析不了的时间戳让映射永远不更新
        const stale = !Number.isFinite(lastMs)
          || (now.getTime() - lastMs) / 86_400_000 >= SECTOR_MEMBERS_MAX_AGE_DAYS;
        if (stale) {
          try {
            const ranks = await collectSectorRankList(db, clients.eastmoney);
            const r = await collectSectorMembers(db, clients.eastmoney, ranks);
            stats.sectorMembersSectors = r.sectors;
            stats.sectorMembersCodes = r.codes;
            stats.sectorMembersFailed = r.failed.length;
          } catch { stats.sectorMembersFailed = -1; }
        }
      }

      /**
       * 指数日线。放在个股全量之前：只有 6 个请求，先拿到能让"今天有没有数据"
       * 这件事更早成立；而且个股那 5,888 次一旦触发新浪限频，指数会跟着一起挂。
       */
      {
        const idx = await collectIndexDaily(db, clients.sina, INDICES, 1023);
        stats.indexWritten = idx.written;
        stats.indexFailed = idx.failed.length;
      }

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

      /**
       * 行数快照。放在最后：今夜写的全都入库了，数出来才对得上。
       *
       * 这活以前长在 web 进程里 —— 设置页和回测实验室都显示这些数字，
       * 缓存 60 秒一过就当场重数 4.1–5.4 秒，而 better-sqlite3 同步，
       * 这 4 秒钉死事件循环，切到那两个页签就是一次卡死。
       * 搬到这里：阻塞 4 秒没有人在等。
       */
      {
        const snap = refreshTableCounts(db, now);
        stats.countedTables = snap.counts.length;
      }
      break;
    }
  }
  return { name, skipped: false, stats };
}
