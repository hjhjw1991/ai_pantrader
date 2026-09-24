import { openDb, type Db } from "@/lib/db";
import { runMigrations } from "@/lib/db/migrate";
import { getConfig } from "@/lib/config";
import { createClient } from "@/lib/data/client";
import { createScheduler, type Scheduler, type SchedulerEvent } from "@/lib/data/scheduler";
import { keepAwake, type KeepAwakeHandle } from "@/lib/platform/keepawake";
import { awakeWindows, hmToMinutes } from "@/lib/data/schedule";
import { shanghaiTs } from "@/lib/data/clock";

/**
 * 采集自启。这是"只要运行过这个量化系统，就会自动唤起数据采集"的落点。
 *
 * 被两个入口共用：
 *   instrumentation.ts   Next 启动时（跑网页就自动采集）
 *   scripts/daemon.ts    无头常驻（不想开网页时）
 *
 * 关掉：设 PANTRADER_NO_SCHEDULER=1。
 * 留这个开关是因为回测/导入导出这类操作不需要采集器在旁边抢限频额度，
 * 而且 CI 里绝不能真去打网络。
 */

let singleton: { scheduler: Scheduler; awake: { stop(): void } } | null = null;

export interface AutostartResult {
  started: boolean;
  reason: string;
  scheduler: Scheduler | null;
}

function log(e: SchedulerEvent): void {
  const t = shanghaiTs();
  if (e.kind === "run") {
    console.log(`[采集 ${t}] ${e.job}@${e.slot} ${JSON.stringify(e.result.stats)}`);
  } else if (e.kind === "fail") {
    console.error(`[采集 ${t}] ${e.job}@${e.slot} 失败：${e.error}`);
  } else if (e.kind === "wake") {
    const a = e.assessment;
    console.warn(
      `[采集 ${t}] 唤醒补偿：上次活动 ${a.lastSeen ?? "无"}`
      + `，沉睡 ${a.dormantMin === null ? "—" : Math.round(a.dormantMin) + " 分钟"}`
      + `｜${a.reason}`
      + (a.stale.length > 0 ? `｜回收 running 残留 ${a.stale.length} 条` : "")
      + (e.markedMissed > 0 ? `｜补记 missed ${e.markedMissed} 个时点` : "")
    );
  } else if (e.kind === "missed") {
    // 不可回补的时点漏了要看得见，不能只记库里
    console.warn(`[采集 ${t}] ${e.job}@${e.slot} 已过期未执行，记为 missed（不可回补）`);
  }
}

/** 当前是否落在需要保持唤醒的时段内 */
export function inAwakeWindow(hm: string): boolean {
  return awakeRemainingSec(hm) > 0;
}

/** 当前所在唤醒时段还剩多少秒；不在任何时段内为 0 */
export function awakeRemainingSec(hm: string): number {
  const t = hmToMinutes(hm);
  const w = awakeWindows().find(x => t >= hmToMinutes(x.from) && t <= hmToMinutes(x.to));
  return w === undefined ? 0 : (hmToMinutes(w.to) - t) * 60;
}

/**
 * 防休眠守卫：每分钟看一次，进入采集时段就申请防休眠，时长给到时段结束，时段外不吊着。
 *
 * 以前只在启动那一刻判断一次 —— 晚上启动的系统，第二天交易时段不会阻止休眠，
 * 而这台机器空闲 1 分钟就睡、盘中快照不可回补。那一段过去靠 launchd 的三个 caffeinate 任务兜着，
 * launchd 拆掉（换电脑后不会跟着走）之后，这件事必须由系统自己做。
 */
export function startAwakeGuard(
  now: () => string = () => shanghaiTs().slice(11, 16),
  acquire: (seconds: number) => KeepAwakeHandle = seconds => keepAwake({ seconds }),
  everyMs = 60_000,
): { tick(): void; stop(): void } {
  let handle: KeepAwakeHandle | null = null;
  let until = 0;
  let warned = false;
  const tick = () => {
    const left = awakeRemainingSec(now());
    if (left <= 0) {
      if (handle !== null) { handle.release(); handle = null; }
      return;
    }
    if (handle !== null && Date.now() < until) return;
    handle?.release();
    handle = acquire(left);
    until = Date.now() + left * 1000;
    if (!handle.active && !warned) { warned = true; console.warn(`[采集] 防休眠不可用：${handle.reason}`); }
  };
  tick();
  const timer = setInterval(tick, everyMs);
  timer.unref?.();
  return { tick, stop: () => { clearInterval(timer); handle?.release(); handle = null; } };
}

export interface AutostartOpts {
  /**
   * 盘前计划实现。lib/data 不反向依赖上层，所以由组装根（scripts/daemon.ts）注入。
   * 不给就只是少跑 plan 这个 job，其余采集照常。
   */
  planPreopen?: (db: Db) => Promise<{ ok: boolean; reason?: string; candidates: unknown[] }>;
  /** 盘中信号盯守实现，同样由组装根注入 */
  signalWatch?: (db: Db) => Promise<{ notified: number; reason?: string }>;
  /** 周复盘实现，同样由组装根注入。不给就只是不出周报，对账照常 */
  weeklyReview?: (db: Db, from: string, to: string) => { stats: { settled: number }; notified: boolean };
  /** 夜间派生表重建，同样由组装根注入。不给则夜间 job 统计里记 derivedSkipped */
  buildDerived?: (db: Db, date: string) => Record<string, number>;
}

export function startAutostart(
  env: NodeJS.ProcessEnv = process.env,
  opts: AutostartOpts = {}
): AutostartResult {
  if (env.PANTRADER_NO_SCHEDULER === "1") {
    return { started: false, reason: "PANTRADER_NO_SCHEDULER=1，采集器未启动", scheduler: null };
  }
  // 同一进程里重复调用（Next 开发模式热重载会重复执行 instrumentation）只启动一次
  if (singleton !== null) {
    return { started: true, reason: "采集器已在运行", scheduler: singleton.scheduler };
  }

  const db = openDb(getConfig(env).dbPath);
  runMigrations(db);

  const clients = {
    sina: createClient("sina", { db, minIntervalMs: 350 }),
    tencent: createClient("tencent", { db, minIntervalMs: 250 }),
    eastmoney: createClient("eastmoney", { db, minIntervalMs: 600 }),
    // 申万 WAF 对并发极敏感（≥3 并发即开始拦截），限速桶给得比别家宽
    sw: createClient("sw", { db, minIntervalMs: 800 }),
    // 同花顺 F10：每晚只抓二三十只发了减持预披露的票，节流给宽一点
    ths: createClient("ths", { db, minIntervalMs: 800 }),
  };

  const scheduler = createScheduler({
    db, clients, runner: "scheduler", onEvent: log,
    ...(opts.planPreopen ? { planPreopen: opts.planPreopen } : {}),
    ...(opts.signalWatch ? { signalWatch: opts.signalWatch } : {}),
    ...(opts.weeklyReview ? { weeklyReview: opts.weeklyReview } : {}),
    ...(opts.buildDerived ? { buildDerived: opts.buildDerived } : {}),
  });
  scheduler.start();

  // 只在采集时段内申请防休眠，不整天吊着不让机器睡；每个时段到了都重新申请
  const awake = startAwakeGuard();

  singleton = { scheduler, awake };
  return { started: true, reason: "采集器已启动（进程内调度，跨平台）", scheduler };
}

export function stopAutostart(): void {
  singleton?.scheduler.stop();
  singleton?.awake.stop();
  singleton = null;
}
