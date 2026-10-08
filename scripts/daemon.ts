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
import {
  detachedSpawnSpec, handoverTo, readLockPid, startFreshnessGuard, watchSuccessor, WATCH_MS,
} from "@/lib/data/freshness";
import { closeDaemonLog, openDaemonLog } from "@/lib/data/daemon-log";
import { currentPlatform } from "@/lib/platform/keepawake";
import { acquireLock, isAlive, releaseLock } from "@/lib/platform/singleton";
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
 * 拉起接班进程。返回它的 pid；**返回 undefined 也可能表示成功** —— Windows 上
 * 为了让接班进程脱离本进程树（detachedSpawnSpec），拉它的是个会立刻退出的
 * powershell，我们只能拿到 powershell 的 pid。那种情况下交班是否成功由锁判定。
 *
 * 三点都是 2026-10-08 两次事故换来的：
 *
 * 1. **输出必须落到文件**：以前用 stdio:"ignore"，接班进程启动即崩时一行报错都没有，
 *    只剩一个死 pid 躺在锁文件里。现在它说什么都记进 logs/。
 * 2. **execArgv 要带上**：tsx 的 `--import=tsx` 在 execArgv 里而不在 argv 里，
 *    漏掉它拉起来的是 `node scripts/daemon.ts` —— Node 解析不了 TS，当场崩。
 * 3. **必须断链**：直接 spawn + detached 的子进程仍在自己的进程树里，本进程一退出，
 *    托管本进程的那个临时任务就回收整棵树，接班进程陪葬 —— 14:35 到 00:29 那
 *    594 分钟没人采集就是这么来的。
 */
function spawnSuccessor(): number | undefined {
  const argv = [...process.execArgv, ...process.argv.slice(1)];
  const env = { ...process.env, PANTRADER_RUNNER: process.env.PANTRADER_RUNNER ?? "manual" };
  const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "");
  const spec = detachedSpawnSpec(
    process.platform, process.execPath, argv,
    // 只有断链那条路用得上这两条路径（见下），POSIX 走统一的 daemon.log
    successorLogPath(stamp), successorLogPath(stamp, ".err"),
  );

  if (spec.pidUnknown) {
    // Windows：**必须断链**（detachedSpawnSpec 里有实测），代价是输出只能交给
    // Start-Process 重定向，而它只会覆盖不会追加 —— 所以一代一份带时间戳的日志，
    // 免得新的一代抹掉上一代启动即崩时留下的那几句遗言。
    try {
      const logsDir = path.join(getConfig().dataDir, "logs");
      fs.mkdirSync(logsDir, { recursive: true });
      pruneOldLogs(logsDir);
    } catch { /* 打不开日志也得起进程 */ }

    const child = spawn(spec.file, spec.args, {
      cwd: process.cwd(), windowsHide: true, stdio: "ignore", env,
    });
    child.on("error", (e) => console.error(`[候潮 daemon] 拉起接班进程失败：${e.message}`));
    child.unref();
    return undefined;   // 拿不到接班进程的 pid，交给锁去认
  }

  // POSIX：detached 已经 setsid，父进程退出不会有 SIGHUP，直接拉；
  // 输出追加进统一的 daemon.log（和 instrumentation 拉起的那次共用同一个落点）
  const fd = openDaemonLog(getConfig().dataDir);   // 打不开会退回 ignore
  const child = spawn(spec.file, spec.args, {
    cwd: process.cwd(), detached: true, windowsHide: true,
    stdio: ["ignore", fd, fd],
    env,
  });
  child.on("error", (e) => console.error(`[候潮 daemon] 拉起接班进程失败：${e.message}`));
  child.unref();
  closeDaemonLog(fd);   // 已 dup 给子进程，父进程这份可以关了
  return child.pid;
}

/** 断链模式下接班进程的日志落点：一代一份，形如 logs/daemon-20261009-1042.log */
function successorLogPath(stamp: string, suffix = ""): string {
  return path.join(getConfig().dataDir, "logs", `daemon-${stamp}${suffix}.log`);
}

/** 交班日志只留最近 7 天的，免得每次交班攒两个文件越攒越多 */
function pruneOldLogs(logsDir: string): void {
  const cutoff = Date.now() - 7 * 24 * 3600 * 1000;
  for (const name of fs.readdirSync(logsDir)) {
    if (!/^daemon-\d{12}(\.err)?\.log$/.test(name)) continue;
    try {
      if (fs.statSync(path.join(logsDir, name)).mtimeMs < cutoff) fs.unlinkSync(path.join(logsDir, name));
    } catch { /* 删不掉就算了 */ }
  }
}

/**
 * 交班成功后留下来当监护人（WATCH_MS，默认 10 分钟）。
 *
 * 为什么不能交完班就走：**本进程退出这个动作**会让托管本进程的临时任务判定命令
 * 结束、回收整个会话的进程，接班进程跟着没。断链（detachedSpawnSpec）能躲开按进程树
 * 的回收，躲不开按会话的回收 —— 实测过，换了 Start-Process 之后接班进程照样在命令
 * 结束那一刻消失。留住本进程，命令就没结束，回收也就不会发生。
 *
 * 这时候采集已经 stop 了，留着不跟接班进程抢活。真发现它没站住，就再拉一个。
 */
async function guardSuccessor(childPid: number): Promise<void> {
  const probe = {
    alive: isAlive,
    lockPid: () => readLockPid(lockPath),
    sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
    now: () => Date.now(),
    log: (m: string) => console.log(`[候潮 daemon] ${m}`),
  };
  for (let attempt = 1; attempt <= 2; attempt++) {
    if ((await watchSuccessor(probe, childPid, WATCH_MS)) === "stable") return;
    probe.log(`接班进程没站住，第 ${attempt} 次重拉`);
    const again = await handoverTo({
      spawn: spawnSuccessor,
      selfPid: process.pid,
      releaseLock: () => releaseLock(lockPath),
      lockPid: probe.lockPid,
      alive: probe.alive,
      sleep: probe.sleep,
      now: probe.now,
      log: probe.log,
    });
    if (!again.ok || again.childPid === undefined) {
      probe.log("重拉也没拉住，本进程退出 —— 请手动重启采集（pnpm daemon）");
      return;
    }
    childPid = again.childPid;
  }
}

startFreshnessGuard(Date.now(), {
  roots: [path.join(process.cwd(), "lib"), path.join(process.cwd(), "scripts")],
  busy: () => r.scheduler?.busy === true,
  spawn: spawnSuccessor,
  // Windows 上 spawnSuccessor 返回 undefined（进程树已断开，拿不到接班 pid），
  // 交班判定要靠"锁被不是我的活进程接管"
  selfPid: process.pid,
  afterHandover: guardSuccessor,
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
