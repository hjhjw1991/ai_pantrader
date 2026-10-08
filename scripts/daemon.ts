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
import { startFreshnessGuard } from "@/lib/data/freshness";
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
 * 拉起接班进程。返回它的 pid，拉不起来返回 undefined。
 *
 * 两点和"直接 spawn + stdio:ignore"不同，都是 2026-10-08 事故换来的：
 *
 * 1. **输出必须落到文件**：以前用 stdio:"ignore"，接班进程启动即崩时一行报错都没有，
 *    只剩一个死 pid 躺在锁文件里。现在它说什么都记进 logs/daemon.log。
 * 2. **execArgv 要带上**：tsx 的 `--import=tsx` 在 execArgv 里而不在 argv 里，
 *    漏掉它拉起来的是 `node scripts/daemon.ts` —— Node 解析不了 TS，当场崩。
 */
function spawnSuccessor(): number | undefined {
  const argv = [...process.execArgv, ...process.argv.slice(1)];
  const logPath = path.join(getConfig().dataDir, "logs", "daemon.log");
  let fd: number | "ignore" = "ignore";
  try {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fd = fs.openSync(logPath, "a");
  } catch { /* 打不开日志也得起进程，退回 ignore */ }

  const child = spawn(process.execPath, argv, {
    cwd: process.cwd(), detached: true, windowsHide: true,
    stdio: ["ignore", fd, fd],
    env: { ...process.env, PANTRADER_RUNNER: process.env.PANTRADER_RUNNER ?? "manual" },
  });
  child.unref();
  if (typeof fd === "number") { try { fs.closeSync(fd); } catch { /* 已 dup 给子进程 */ } }
  return child.pid;
}

startFreshnessGuard(Date.now(), {
  roots: [path.join(process.cwd(), "lib"), path.join(process.cwd(), "scripts")],
  busy: () => r.scheduler?.busy === true,
  spawn: spawnSuccessor,
  lockPath,
  // 让位：交班必须先把锁交出去。握着锁等的话，接班进程启动第一步 acquireLock
  // 会看到一个活着的持锁进程，打印"已有采集进程在运行"直接退出 —— 两个进程一起没
  releaseLock: () => releaseLock(lockPath),
  // 交班失败时接班进程可能已经把锁写成自己的 pid 才崩 —— 不拿回来的话，
  // 锁上是个死 pid，下一个拉起的进程会以为没人采集而重复启动
  retakeLock: () => acquireLock(lockPath).acquired,
  stop: () => stopAutostart(),
  exit: () => process.exit(0),
  sleep: (ms) => new Promise((res) => setTimeout(res, ms)),
  now: () => Date.now(),
  log: (msg) => console.log(`[候潮 daemon] ${msg}`),
});

// 常驻：调度器的 timer 是 unref 的，这里显式挂住进程
setInterval(() => {}, 1 << 30);
