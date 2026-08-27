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

let singleton: { scheduler: Scheduler; awake: KeepAwakeHandle | null } | null = null;

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
  const t = hmToMinutes(hm);
  return awakeWindows().some(w => t >= hmToMinutes(w.from) && t <= hmToMinutes(w.to));
}

export interface AutostartOpts {
  /**
   * 盘前计划实现。lib/data 不反向依赖上层，所以由组装根（scripts/daemon.ts）注入。
   * 不给就只是少跑 plan 这个 job，其余采集照常。
   */
  planPreopen?: (db: Db) => Promise<{ ok: boolean; reason?: string; candidates: unknown[] }>;
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
  };

  const scheduler = createScheduler({
    db, clients, runner: "scheduler", onEvent: log,
    ...(opts.planPreopen ? { planPreopen: opts.planPreopen } : {}),
  });
  scheduler.start();

  // 只在采集时段内申请防休眠，不整天吊着不让机器睡
  const hm = shanghaiTs().slice(11, 16);
  const awake = inAwakeWindow(hm)
    ? keepAwake({ seconds: 3600 })
    : null;
  if (awake !== null && !awake.active) console.warn(`[采集] 防休眠不可用：${awake.reason}`);

  singleton = { scheduler, awake };
  return { started: true, reason: "采集器已启动（进程内调度，跨平台）", scheduler };
}

export function stopAutostart(): void {
  singleton?.scheduler.stop();
  singleton?.awake?.release();
  singleton = null;
}
