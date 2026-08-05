/**
 * Next 启动钩子 —— "跑起这个量化系统就自动开始采集"的落点。
 *
 * 这里**不直接**引入采集代码，而是拉起独立的守护进程。三个理由：
 *   1. better-sqlite3 是原生模块，Next 会把 instrumentation 也编进 edge bundle，
 *      直接 import 会构建失败（Can't resolve 'fs'）。
 *      连 child_process/path 都不能用 import 取 —— 走 process.getBuiltinModule。
 *   2. 开发模式热重载会反复执行本文件，独立进程 + PID 锁天然幂等。
 *   3. 采集与网页解耦：网页崩了/重启了，采集不受影响。
 *
 * 与 `pnpm daemon` 共用同一个 scripts/daemon.ts，不存在两份实现。
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.PANTRADER_NO_SCHEDULER === "1") {
    console.log("[PanTrader] PANTRADER_NO_SCHEDULER=1，未启动采集");
    return;
  }

  // process.getBuiltinModule 是 Node 22 内建：打包器静态分析不到它，
  // 所以 edge 编译不会去解析 child_process/path（那会报 Can't resolve）。
  // 这一行到这里才执行，此时已确认是 nodejs runtime。
  const { spawn } = process.getBuiltinModule("child_process");
  const path = process.getBuiltinModule("path");

  const script = path.join(process.cwd(), "scripts", "daemon.ts");
  // 用当前 node 可执行文件 + tsx loader，跨平台且不依赖 PATH 里有 pnpm
  const child = spawn(process.execPath, ["--import=tsx", script], {
    cwd: process.cwd(),
    detached: true,
    stdio: "ignore",
    env: { ...process.env, PANTRADER_RUNNER: "instrumentation" },
  });
  child.on("error", e => console.error(`[PanTrader] 采集守护进程启动失败：${e.message}`));
  // detach：网页进程退出后采集继续跑
  child.unref();
  console.log(`[PanTrader] 采集守护进程已拉起（pid ${child.pid}），跨平台进程内调度`);
}
