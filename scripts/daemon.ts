/**
 * 常驻采集守护进程。跨平台（macOS / Windows / Linux），纯 Node。
 *
 * 两个入口共用本文件：
 *   `pnpm daemon`      手动常驻
 *   instrumentation.ts 网页服务启动时自动拉起
 *
 * PID 锁保证同时只有一个：重复拉起会让两个进程同时拉 5888 只快照，互相把免费源打挂。
 *
 * ── 常驻进程最大的陷阱：代码冻结 ──
 *
 * 这个进程可能一跑就是几天（实测连续 3 天），而 Node 只在启动那一刻读一遍源码。
 * 于是"改了 lib/data/collectors/daily.ts 的复权因子写法"发生在这之后的话，
 * 它完全看不见 —— 还会按旧逻辑每天写一行坏数据，而作者这边测过、提交过、
 * 以为已经修好了。2026-09-28 / 09-29 连续两天全市场的最新交易日复权因子被写成 1.0，
 * 图上历史价集体放大 5.8 倍，就是这么来的。
 *
 * 所以这里挂一个**新鲜度守卫**：发现自己引用的源码比我更新，
 * 就等这一轮 job 跑完、交班重启（见文件末尾的 startFreshnessGuard）。
 * 另外启动时先做一次写侧自愈，把上一次冻结进程留下的坏行爬起来。
 */
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { getConfig } from "@/lib/config";
import { repairTrailingAdjFactors } from "@/lib/data/collectors/daily";
import { openDb } from "@/lib/db";
import { runMigrations } from "@/lib/db/migrate";
import { startAutostart, stopAutostart } from "@/lib/data/autostart";
import { currentPlatform } from "@/lib/platform/keepawake";
import { acquireLock, releaseLock } from "@/lib/platform/singleton";
import { runPreopenPlan } from "@/lib/plan/preopen";
import { runSignalWatch } from "@/lib/plan/watch";
import { runWeeklyReview } from "@/lib/plan/review";
import { runNightlyDerived } from "@/lib/plan/derived";
// CLI 不读 .env.local（只有 next 会读），这里补上，免得在默认目录上新建/操作一个空库
import { loadCliEnv } from "@/lib/config";
loadCliEnv();

const lockPath = path.join(getConfig().dataDir, "scheduler.pid");
const lock = acquireLock(lockPath);

if (!lock.acquired) {
  console.log(`[候潮 daemon] 已有采集进程在运行（pid ${lock.heldBy}），本进程退出`);
  process.exit(0);
}

/**
 * 启动自愈：把"上一任冻结进程"写坏的复权因子修回来。
 *
 * 纯本地 SQL、幂等，几万行也就几秒。放在这里而不是只等夜间 job：
 * 从 daemon 冷启动到下一个交易日收盘之间，界面上看到的图应该是干净的。
 */
function healAdjFactors(): void {
  try {
    const db = openDb(getConfig().dbPath);
    runMigrations(db);
    const n = repairTrailingAdjFactors(db);
    db.close();
    if (n > 0) console.log(`[候潮 daemon] 启动自愈：修正 ${n} 行写坏的复权因子`);
  } catch (e) {
    // 自愈失败不该挡住采集启动，写出来就行
    console.warn(`[候潮 daemon] 复权因子自愈失败：${(e as Error).message}`);
  }
}
healAdjFactors();

// 组装根：把盘前计划的实现注进采集层。lib/data 自己不反向依赖上层（见 JobDeps.planPreopen）
const r = startAutostart(process.env, {
  planPreopen: runPreopenPlan, signalWatch: runSignalWatch, weeklyReview: runWeeklyReview,
  buildDerived: runNightlyDerived,
});
console.log(
  `[候潮 daemon] 平台=${currentPlatform()} pid=${process.pid} ` +
  `runner=${process.env.PANTRADER_RUNNER ?? "manual"} ${r.reason}`
);
if (!r.started) { releaseLock(lockPath); process.exit(1); }

function shutdown(sig: string): void {
  console.log(`\n[候潮 daemon] 收到 ${sig}，停止采集`);
  stopAutostart();
  releaseLock(lockPath);
  process.exit(0);
}
for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => shutdown(sig));
// 进程被强杀时锁会变成僵尸锁，acquireLock 会检测 PID 存活后自动接管
process.on("exit", () => releaseLock(lockPath));

/**
 * 代码新鲜度守卫：发现"被引用的源码比我启动更晚"就更替重启。
 *
 * 三道闸，每一道都是实测踩出来的：
 *
 * 1. **等这一轮 job 跑完**：半路退会留下 running 残行，下次还得靠回收逻辑擦屁股。
 *    不记"待重启"标志 —— mtime 不会变老，跑完那轮自己就会再看到。
 * 2. **等改动停下来（SETTLE_MS）**：一次保存常常连着写几个文件，
 *    刚看到第一个就重启，会把半成品的中间状态拉起来。
 * 3. **交班前必须真的拉起新进程**：tsx 的 `--import=tsx` 在 execArgv 里、
 *    不在 argv 里，漏掉它拉起来的是 `node scripts/daemon.ts` —— Node 解析不了 TS，
 *    新进程当场崩，旧进程已经退了，于是**采集进程凭空消失**
 *    （实测就是这么没的：pid 文件停在旧 pid，界面不再有数据进来）。
 *
 * 为什么用 mtime 而不是 git：仓库可能在没 git 的机器上跑，而 mtime 是免费现成的。
 * 只看 .ts —— 改注释和文档不该让人白等一次重启。
 */
const SETTLE_MS = 30_000;

function startFreshnessGuard(sinceMs: number, busy: () => boolean, everyMs = 60_000): void {
  const roots = [path.join(process.cwd(), "lib"), path.join(process.cwd(), "scripts")];

  /** 返回 [最新改动文件, 它的 mtime]；没有比 sinceMs 更新的改动则为 null */
  const newest = (dir: string): { file: string; mtime: number } | null => {
    let best: { file: string; mtime: number } | null = null;
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, ent.name);
      try {
        if (ent.isDirectory()) {
          const hit = newest(p);
          if (hit && (best === null || hit.mtime > best.mtime)) best = hit;
          continue;
        }
        if (!ent.name.endsWith(".ts")) continue;
        const ms = fs.statSync(p).mtimeMs;
        if (ms > sinceMs && (best === null || ms > best.mtime)) best = { file: p, mtime: ms };
      } catch { /* 文件被删 / 没权限：跳过，不该为此重启 */ }
    }
    return best;
  };

  const timer = setInterval(() => {
    try {
      // 有 job 在跑：等下一轮。改动不会因此消失，mtime 不会变老
      if (busy()) return;

      let hit: { file: string; mtime: number } | null = null;
      for (const root of roots) {
        const h = newest(root);
        if (h !== null && (hit === null || h.mtime > hit.mtime)) hit = h;
      }
      if (hit === null) return;
      if (Date.now() - hit.mtime < SETTLE_MS) return;   // 还在改，等它停下来

      const argv = [...process.execArgv, ...process.argv.slice(1)];
      const child = spawn(process.execPath, argv, {
        cwd: process.cwd(), detached: true, stdio: "ignore", windowsHide: true,
        env: { ...process.env, PANTRADER_RUNNER: process.env.PANTRADER_RUNNER ?? "manual" },
      });
      if (child.pid === undefined) {
        console.warn("[候潮 daemon] 交班失败：新进程没拉起来，本进程继续跑");
        return;
      }
      child.unref();
      console.log(`[候潮 daemon] 检测到代码更新（${hit.file}），交班给 pid ${child.pid}`);
      stopAutostart();
      releaseLock(lockPath);
      clearInterval(timer);
      process.exit(0);
    } catch (e) {
      console.warn(`[候潮 daemon] 新鲜度守卫出错：${(e as Error).message}`);
    }
  }, everyMs);
  timer.unref?.();
}

startFreshnessGuard(Date.now(), () => r.scheduler?.busy === true);

// 常驻：调度器的 timer 是 unref 的，这里显式挂住进程
setInterval(() => {}, 1 << 30);
