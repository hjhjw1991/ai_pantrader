import type { Db } from "@/lib/db";
import type { JobName } from "@/lib/data/jobs";
import { SCHEDULE } from "@/lib/data/schedule";
import { shanghaiTs, shanghaiDay } from "@/lib/data/clock";
import { isTradingDay, tradingDaysBetween } from "@/lib/data/calendar";
import { systemStartDate } from "@/lib/data/meta";

/**
 * 唤醒补偿。系统重新活过来时（进程重启，或机器休眠后醒来）先问一句：
 * **我上次干活是什么时候？中间漏了什么？**
 *
 * 为什么需要这个 —— 调度器原本只看"今天"的时刻表，于是有三个洞：
 *
 *   1. 跨天未结清。周五 20:00 关机、周一 09:00 开机，dueSlots(周一) 只查周一的时点，
 *      周五的 night（全量日线）**本来完全可回补**，
 *      但 job_run 里连行都没有，从此没人再看它们一眼 —— 静默永久丢失。
 *      更隐蔽的一种：周五 10:00 睡过去，那天有 14 条 done，
 *      剩下 34 个盘中时点连行都没有 —— 覆盖率读成 14/14 = 100%，账是假的。
 *
 *   2. running 残留。合盖休眠在 night 跑到一半时打断进程，那行永远停在 running。
 *      claimed() 认为时点已被占 → 既不会重跑、也不会记 missed，
 *      覆盖率的分子分母都少一个，账是错的。
 *
 *   3. 进程活着但机器睡了。start() 只在进程启动时跑一轮，
 *      醒来后 setInterval 继续 tick，可跨天的洞（1）仍然没人补。
 *
 * 补偿方式是**结构性的，不是逐日重放**。这点很关键：
 *   night 一次拉 1023 根日线 → 覆盖任意多个漏采日的日线
 *   lhbRefreshDates 覆盖近 30 个交易日 → 覆盖漏采日的龙虎榜
 *   backfillRecoverable 收尾可回补缺口
 * 所以不管漏了 3 天还是 30 天，跑 preopen + night 各一次就够。
 * 逐日重放是纯白烧限频额度：同样的 1023 根日线拉 30 遍。
 *
 * 快照与分钟线相反，是**过去时点的现场**，永远补不回来。
 * 那些时点如实记成 missed —— 记成别的等于伪造覆盖率。
 */

/** running 超过 durationMin 的这个倍数，判定为进程中断残留 */
export const STALE_CLAIM_FACTOR = 3;
/** 短 job 也要给足余量：limiter 排队 + 熔断退避可以拖很久 */
export const STALE_CLAIM_FLOOR_MIN = 15;
/** 两次 tick 间隔超过这么久，认为机器睡过一觉，重新做一次唤醒评估 */
export const WAKE_GAP_MIN = 15;

/**
 * 跨天补不补得回来。**不要用 catchUp 代替这个判断** ——
 * catchUp 是日内语义（close 是 all，因为 16:00 补跑仍能拿到当日涨停池），
 * 跨天语义完全不同（close 内部用的日期是"今天"，对暗日跑一遍什么也没补回来）。
 */
const backfillsOf = (job: string): boolean =>
  SCHEDULE.find(j => j.job === job)?.backfillsAcrossDays ?? false;

const durationOf = (job: string): number =>
  SCHEDULE.find(j => j.job === job)?.durationMin ?? 1;

/** 最后一次有采集活动的时刻（不论成败）。null = 从没跑过 */
export function lastActivity(db: Db): string | null {
  const r = db.prepare(
    `SELECT MAX(COALESCE(finished_at, started_at)) t FROM job_run
     WHERE started_at IS NOT NULL`
  ).get() as { t: string | null };
  return r?.t ?? null;
}

/**
 * 残留怎么处理。requeue = 删掉占位让 dueSlots 重新认领。
 *
 * 过去日期的残留一律 fail，**不能 requeue**：dueSlots 只看今天，
 * 删掉一条昨天的占位等于让它凭空消失 —— 既不重跑、也不记 missed，
 * 覆盖率的分母都少一个，比留着 running 更糟。
 */
function staleAction(job: string, rowDate: string, today: string): "requeue" | "fail" {
  if (rowDate !== today) return "fail";
  return (SCHEDULE.find(j => j.job === job)?.catchUp ?? "latest") === "all"
    ? "requeue" : "fail";
}

export interface StaleClaim {
  date: string; job: string; slot: string; startedAt: string;
  /** 可回补的删掉让它重跑；不可回补的记 failed，重跑没有意义 */
  action: "requeue" | "fail";
}

/**
 * 回收 running 残留。判定只看一件事：**这行 running 了多久**，
 * 门槛取 max(durationMin × 3, 15min)。
 *
 * 曾经还加过一条"只回收早于本进程启动时刻的行"，看着像安全检查，其实是个洞：
 * 机器休眠醒来时进程根本没重启，processStart 还是几小时前的值，
 * 于是被休眠打断的那行 started ≥ processStart，永远不被回收 ——
 * 恰好把最需要它的场景堵死了。已删。
 *
 * 那么怎么防止抢走同机另一个 runner 正在跑的活？靠门槛本身：
 * night 实测 30 分钟，门槛 120 分钟；其余 job 秒级，门槛 15 分钟。
 * 一个活着的进程超过 3 倍预估还没结束，它自己已经出问题了。
 * 本进程这边不需要额外保护 —— tickOnce 是串行的，
 * 唤醒评估发生在本轮任何 claim 之前，此刻本进程手上不持有未结的占位。
 */
export function findStaleClaims(db: Db, at: Date): StaleClaim[] {
  const rows = db.prepare(
    `SELECT date, job, slot, started_at FROM job_run WHERE status = 'running'`
  ).all() as Array<{ date: string; job: string; slot: string; started_at: string }>;

  const out: StaleClaim[] = [];
  const today = shanghaiDay(at);
  for (const r of rows) {
    const started = Date.parse(`${r.started_at.replace(" ", "T")}+08:00`);
    if (Number.isNaN(started)) continue;
    const ageMin = (at.getTime() - started) / 60_000;
    const limit = Math.max(durationOf(r.job) * STALE_CLAIM_FACTOR, STALE_CLAIM_FLOOR_MIN);
    if (ageMin < limit) continue;
    out.push({
      date: r.date, job: r.job, slot: r.slot, startedAt: r.started_at,
      action: staleAction(r.job, r.date, today),
    });
  }
  return out;
}

/**
 * 落实回收。**绝不给回收的行写 finished_at** —— 那个字段的含义是"这个 job 干完了"，
 * 盖上当前时间等于声称它刚刚才结束。后果不只是记录不准：
 * lastActivity 用 COALESCE(finished_at, started_at)，被盖之后"最后一次活动"
 * 就变成了"刚刚"，于是下一次唤醒评估算出沉睡 0 分钟、漏采日 0 天，
 * 补偿凭空消失。实测踩到过：回收后二次评估 compensate 从 [preopen,night] 变成 []。
 */
export function reclaimStaleClaims(db: Db, claims: StaleClaim[]): number {
  const del = db.prepare(`DELETE FROM job_run WHERE date = ? AND job = ? AND slot = ?`);
  const fail = db.prepare(
    `UPDATE job_run SET status = 'failed', error = ?
     WHERE date = ? AND job = ? AND slot = ?`
  );
  const reason = "进程中断（休眠/被杀）导致 running 残留，已回收";
  db.transaction(() => {
    for (const c of claims) {
      // requeue：删掉占位，dueSlots 下一轮会重新认领并真跑一遍
      if (c.action === "requeue") del.run(c.date, c.job, c.slot);
      else fail.run(`${reason}（快照类时点不可回补，不重跑）`, c.date, c.job, c.slot);
    }
  })();
  return claims.length;
}

/**
 * 未结清的交易日：last activity 之后、今天之前的**每个**交易日。
 * 上界不含今天 —— 今天的时点交给正常的 dueSlots 走，那才是权威路径。
 *
 * 早前只挑"job_run 一条记录都没有"的全暗日，漏掉了更常见的一种：
 * 机器在 10:00 睡过去，那天有 14 条 done、剩下 34 个盘中时点连行都没有。
 * 那天不是"全暗"，于是不被处理，覆盖率读成 14/14 = 100% —— 账是假的。
 * 所以逐日全取，靠 INSERT OR IGNORE 保护已有记录，而不是靠"这天是否全暗"筛。
 */
export function unaccountedDays(db: Db, lastSeenDate: string, today: string): string[] {
  const since = systemStartDate(db, today);
  const from = lastSeenDate < since ? since : lastSeenDate;
  return tradingDaysBetween(db, from, today).filter(d => d !== today);
}

/** 那天可回补的 job 有没有真跑成过。night 是日线与龙虎榜标签的总闸门 */
function backfillSettled(db: Db, date: string): boolean {
  return db.prepare(
    `SELECT 1 FROM job_run WHERE date = ? AND job = 'night' AND status = 'done' LIMIT 1`
  ).get(date) !== undefined;
}

/**
 * 把这些日子里**跨天补不回来**的时点如实记成 missed（intraday / close）。
 * 可回补的（preopen/post/night）不标 —— 它们由本次补偿真的跑掉，标了就是重复记账。
 */
export function markUnaccountedMissed(db: Db, days: string[]): number {
  const ins = db.prepare(
    `INSERT OR IGNORE INTO job_run (date, job, slot, status, runner)
     VALUES (?, ?, ?, 'missed', 'scheduler')`
  );
  let n = 0;
  db.transaction(() => {
    for (const d of days) {
      if (!isTradingDay(db, d)) continue;
      for (const j of SCHEDULE) {
        if (j.backfillsAcrossDays) continue;
        for (const s of j.slots) n += ins.run(d, j.job, s).changes;
      }
    }
  })();
  return n;
}

/**
 * 沉睡期间是否跨过了日历日。**这是同步日历的判据，且必须在评估漏采日之前做。**
 *
 * 为什么不能反过来 —— trading_calendar 是从指数的历史 K 线推出来的，
 * 所以它的 max(date) 永远等于"上次同步那天"，**永远不含未来日期**。
 * 关机两周再开机时，日历里根本没有那两周的任何一天，
 * tradingDaysBetween 返回空 → 漏采日 0 天 → 补偿一次都不触发，静默失效。
 * 所以顺序只能是：先同步日历，再判断漏了哪些交易日。
 */
export function crossedCalendarDay(lastSeen: string | null, at: Date): boolean {
  return lastSeen !== null && lastSeen.slice(0, 10) < shanghaiDay(at);
}

export interface WakeAssessment {
  /** 最后一次采集活动。null = 首次运行，不做任何补偿 */
  lastSeen: string | null;
  /** 沉睡时长（分钟）。null = 首次运行 */
  dormantMin: number | null;
  stale: StaleClaim[];
  /** 需要如实记 missed 的交易日（今天之前） */
  unaccounted: string[];
  /** 这些日子的可回补数据没落地过，是补偿的触发源 */
  unsettled: string[];
  /** 要补跑的 job。结构性覆盖，不逐日重放 */
  compensate: JobName[];
  reason: string;
}

/**
 * 评估要不要补偿。纯读，不写库 —— 便于测试，也便于先打日志再决定跑不跑。
 *
 * 触发补偿的条件是**有交易日的可回补数据没落地**，而不是"沉睡超过 N 小时"。
 * 用时长做阈值会同时犯两种错：周末关机 60 小时其实一天都没漏（休市），
 * 而周四 23:00 到周五 09:00 只隔 10 小时却漏掉了整个周五。
 * 交易日历 + 那天 night 跑成没有，才是判据。
 *
 * `lastSeen` 必须由调用方**在做任何写库动作之前**取好再传进来，不能在这里现取。
 * 回收残留、同步日历都会往 job_run 写行，一写 lastActivity 就变成"刚刚"，
 * 自己把自己的判据抹掉。实测踩过：同步完日历再评估，compensate 直接变空。
 */
export function assessWake(
  db: Db, at: Date, lastSeen: string | null, stale: StaleClaim[] = []
): WakeAssessment {
  const today = shanghaiDay(at);

  if (lastSeen === null) {
    return {
      lastSeen: null, dormantMin: null, stale, unaccounted: [], unsettled: [],
      compensate: [], reason: "首次运行，无历史可补",
    };
  }

  const dormantMin = Math.max(
    0, (at.getTime() - Date.parse(`${lastSeen.replace(" ", "T")}+08:00`)) / 60_000
  );
  const unaccounted = unaccountedDays(db, lastSeen.slice(0, 10), today);
  const unsettled = unaccounted.filter(d => !backfillSettled(db, d));
  const dormant = `沉睡 ${Math.round(dormantMin)} 分钟`;

  if (unsettled.length === 0) {
    return {
      lastSeen, dormantMin: Number(dormantMin.toFixed(1)), stale, unaccounted,
      unsettled, compensate: [],
      reason: unaccounted.length === 0
        ? `${dormant}，期间没有跨过交易日，今天的时点交给常规调度`
        : `${dormant}，期间 ${unaccounted.length} 个交易日的可回补数据都已落地`,
    };
  }

  return {
    lastSeen, dormantMin: Number(dormantMin.toFixed(1)), stale, unaccounted, unsettled,
    // 只跑一次 night —— 它拉 1023 根日线 + 刷近 30 个交易日的龙虎榜 + 回补可回补缺口，
    // 逐日重放是把同样的 1023 根拉 N 遍，纯白烧限频额度。
    // preopen 不在这里：它是**判据的前提**，由 crossedCalendarDay 在评估之前就跑掉了
    compensate: (["night"] as JobName[]).filter(j => backfillsOf(j)),
    reason: `${dormant}，${unsettled.length} 个交易日的可回补数据未落地`
      + `（${unsettled[0]}…${unsettled[unsettled.length - 1]}）：`
      + `补跑 night 一次做结构性覆盖；快照类时点如实记 missed`,
  };
}

/** 唤醒补偿用的时点标签，与时刻表时点区分开，不占用真实时点 */
export function wakeSlot(at: Date): string {
  return `wake:${shanghaiTs(at).slice(11, 19)}`;
}
