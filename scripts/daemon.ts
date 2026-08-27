/**
 * 常驻采集守护进程。跨平台（macOS / Windows / Linux），纯 Node。
 *
 * 两个入口共用本文件：
 *   `pnpm daemon`      手动常驻
 *   instrumentation.ts 网页服务启动时自动拉起
 *
 * PID 锁保证同时只有一个：重复拉起会让两个进程同时拉 5888 只快照，互相把免费源打挂。
 */
import path from "node:path";
import { getConfig } from "@/lib/config";
import { startAutostart, stopAutostart } from "@/lib/data/autostart";
import { currentPlatform } from "@/lib/platform/keepawake";
import { acquireLock, releaseLock } from "@/lib/platform/singleton";
import { runPreopenPlan } from "@/lib/plan/preopen";

const lockPath = path.join(getConfig().dataDir, "scheduler.pid");
const lock = acquireLock(lockPath);

if (!lock.acquired) {
  console.log(`[PanTrader daemon] 已有采集进程在运行（pid ${lock.heldBy}），本进程退出`);
  process.exit(0);
}

// 组装根：把盘前计划的实现注进采集层。lib/data 自己不反向依赖上层（见 JobDeps.planPreopen）
const r = startAutostart(process.env, { planPreopen: runPreopenPlan });
console.log(
  `[PanTrader daemon] 平台=${currentPlatform()} pid=${process.pid} ` +
  `runner=${process.env.PANTRADER_RUNNER ?? "manual"} ${r.reason}`
);
if (!r.started) { releaseLock(lockPath); process.exit(1); }

function shutdown(sig: string): void {
  console.log(`\n[PanTrader daemon] 收到 ${sig}，停止采集`);
  stopAutostart();
  releaseLock(lockPath);
  process.exit(0);
}
for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => shutdown(sig));
// 进程被强杀时锁会变成僵尸锁，acquireLock 会检测 PID 存活后自动接管
process.on("exit", () => releaseLock(lockPath));

// 常驻：调度器的 timer 是 unref 的，这里显式挂住进程
setInterval(() => {}, 1 << 30);
