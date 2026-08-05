import type { Db } from "@/lib/db";
import type { JobDeps, JobName, JobResult } from "@/lib/data/jobs";
import { runJob, jobOutcome } from "@/lib/data/jobs";
import { SCHEDULE, hmToMinutes } from "@/lib/data/schedule";
import { shanghaiTs } from "@/lib/data/clock";
import { isTradingDay } from "@/lib/data/calendar";

/**
 * 进程内调度器。跨平台（纯 Node，不依赖 launchd / cron / 计划任务），
 * 随源码走，**跑起这个量化系统就自动开始采集**。
 *
 * 三件必须做对的事：
 *
 * 1. 启动即补跑。用户中午才打开系统，上午的时点已经过去 —— 这时要能判断
 *    哪些跑过、哪些没跑，并按各 job 的补跑策略处理（见 schedule.ts 的 catchUp）。
 *    没跑过的不可回补时点记成 missed 而不是 done：把没采到的记成成功等于伪造覆盖率。
 *
 * 2. 与 OS 级任务共存去重。macOS 上可能已经装了 launchd agent，
 *    用户又开着系统；或者开两个终端各跑一个。共享 job_run 表做去重，
 *    主键 (date, job, slot) 保证同一时点只执行一次 —— 否则 5888 只的全市场快照
 *    会被重复拉几遍，白烧限频额度还可能把免费源打挂。
 *
 * 3. 串行执行。绝不并发跑两个采集 job：几个免费源都很容易限频，
 *    实测东财十几次请求就整体掉线。宁可晚几十秒，不要一起冲。
 */

export type Runner = "scheduler" | "launchd" | "schtasks" | "manual";

export interface SchedulerOpts {
  db: Db;
  clients: JobDeps["clients"];
  /** 注入时钟，测试用。默认真实时间 */
  now?: () => Date;
  /** 轮询间隔。默认 30s —— 时点粒度是分钟，30s 足够且几乎不耗资源 */
  tickMs?: number;
  runner?: Runner;
  onEvent?: (e: SchedulerEvent) => void;
}

export type SchedulerEvent =
  | { kind: "run"; job: JobName; slot: string; result: JobResult }
  | { kind: "fail"; job: JobName; slot: string; error: string }
  | { kind: "missed"; job: JobName; slot: string }
  | { kind: "skip"; job: JobName; slot: string; reason: string };

const shanghaiParts = (d: Date) => {
  const ts = shanghaiTs(d);
  return { date: ts.slice(0, 10), hm: ts.slice(11, 16) };
};

/** 这个时点是否已经被任何 runner 处理过（做过就不再做） */
function claimed(db: Db, date: string, job: string, slot: string): boolean {
  return db.prepare(
    `SELECT 1 FROM job_run WHERE date = ? AND job = ? AND slot = ?`
  ).get(date, job, slot) !== undefined;
}

/**
 * 抢占一个时点。靠主键冲突做原子占位 —— 两个进程同时抢，只有一个 INSERT 成功。
 * 返回 false 表示别人已经拿到了，本进程直接放手。
 */
function claim(db: Db, date: string, job: string, slot: string, runner: Runner): boolean {
  try {
    db.prepare(
      `INSERT INTO job_run (date, job, slot, status, started_at, runner)
       VALUES (?, ?, ?, 'running', ?, ?)`
    ).run(date, job, slot, shanghaiTs(), runner);
    return true;
  } catch {
    return false;   // UNIQUE 冲突 = 已被占
  }
}

function finish(
  db: Db, date: string, job: string, slot: string,
  status: "done" | "failed", stats?: unknown, error?: string
): void {
  db.prepare(
    `UPDATE job_run SET status = ?, finished_at = ?, stats_json = ?, error = ?
     WHERE date = ? AND job = ? AND slot = ?`
  ).run(status, shanghaiTs(), stats === undefined ? null : JSON.stringify(stats),
        error ?? null, date, job, slot);
}

function markMissed(db: Db, date: string, job: string, slot: string, runner: Runner): void {
  try {
    db.prepare(
      `INSERT INTO job_run (date, job, slot, status, runner) VALUES (?, ?, ?, 'missed', ?)`
    ).run(date, job, slot, runner);
  } catch { /* 已有记录，说明别人跑过或已标记 */ }
}

export interface DueSlot { job: JobName; slot: string; action: "run" | "missed" }

/**
 * 算出当前该做什么。纯函数（只读 DB），便于测试。
 *
 * 对每个 job：取所有 `slot <= 现在` 且没有 job_run 记录的时点。
 *   catchUp=all    → 全部 run
 *   catchUp=latest → 最后一个 run，其余 missed
 */
export function dueSlots(db: Db, at: Date): DueSlot[] {
  const { date, hm } = shanghaiParts(at);
  const nowMin = hmToMinutes(hm);
  const out: DueSlot[] = [];

  for (const j of SCHEDULE) {
    const pending = j.slots
      .filter(s => hmToMinutes(s) <= nowMin)
      .filter(s => !claimed(db, date, j.job, s));
    if (pending.length === 0) continue;

    if (j.catchUp === "all") {
      for (const s of pending) out.push({ job: j.job, slot: s, action: "run" });
    } else {
      const last = pending[pending.length - 1];
      for (const s of pending) {
        out.push({ job: j.job, slot: s, action: s === last ? "run" : "missed" });
      }
    }
  }
  return out;
}

export interface Scheduler {
  /** 立即执行一轮（启动时的"自动唤起"就是这个） */
  tickOnce(): Promise<void>;
  start(): void;
  stop(): void;
  readonly running: boolean;
}

export function createScheduler(o: SchedulerOpts): Scheduler {
  const now = o.now ?? (() => new Date());
  const tickMs = o.tickMs ?? 30_000;
  const runner = o.runner ?? "scheduler";
  const emit = o.onEvent ?? (() => {});

  let timer: NodeJS.Timeout | null = null;
  // 串行闸门：上一轮没跑完就不开下一轮，避免慢 job（night 约 30 分钟）被叠着起
  let busy = false;

  async function tickOnce(): Promise<void> {
    if (busy) return;
    busy = true;
    try {
      const at = now();
      const { date } = shanghaiParts(at);

      for (const d of dueSlots(o.db, at)) {
        if (d.action === "missed") {
          // 非交易日不标 missed：那不是漏采，是本来就不该采，
          // 标了会让缺口告警长期噪音化
          if (isTradingDay(o.db, date)) {
            markMissed(o.db, date, d.job, d.slot, runner);
            emit({ kind: "missed", job: d.job, slot: d.slot });
          }
          continue;
        }

        if (!claim(o.db, date, d.job, d.slot, runner)) {
          emit({ kind: "skip", job: d.job, slot: d.slot, reason: "已被其他 runner 执行" });
          continue;
        }

        try {
          const result = await runJob(d.job, { db: o.db, clients: o.clients, now: at });
          // 没抛错 ≠ 成功：采集器批次失败时记 gap 后继续，全军覆没也会正常返回
          const outcome = jobOutcome(d.job, result.stats);
          if (outcome.ok) {
            finish(o.db, date, d.job, d.slot, "done", result.stats);
            emit({ kind: "run", job: d.job, slot: d.slot, result });
          } else {
            finish(o.db, date, d.job, d.slot, "failed", result.stats, outcome.reason);
            emit({ kind: "fail", job: d.job, slot: d.slot, error: outcome.reason! });
          }
        } catch (e: any) {
          const msg = String(e?.message ?? e);
          finish(o.db, date, d.job, d.slot, "failed", undefined, msg);
          emit({ kind: "fail", job: d.job, slot: d.slot, error: msg });
          // 单个 job 失败不能中断整轮：后面的时点还得照跑
        }
      }
    } finally {
      busy = false;
    }
  }

  return {
    tickOnce,
    start() {
      if (timer !== null) return;
      // 立刻跑一轮："只要运行过这个系统就自动唤起采集"
      void tickOnce();
      timer = setInterval(() => void tickOnce(), tickMs);
      timer.unref?.();     // 不因为调度器而拖住进程退出
    },
    stop() {
      if (timer !== null) clearInterval(timer);
      timer = null;
    },
    get running() { return timer !== null; },
  };
}

/** 今日执行概览，给设置页与 selfcheck 用 */
export function todayRuns(db: Db, date: string): Array<{
  job: string; slot: string; status: string; error: string | null;
}> {
  return db.prepare(
    `SELECT job, slot, status, error FROM job_run WHERE date = ? ORDER BY slot, job`
  ).all(date) as any[];
}
