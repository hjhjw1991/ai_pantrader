/**
 * 守护进程的输出落点：`<dataDir>/logs/daemon.log`。
 *
 * 为什么单独成文件：拉起守护进程的地方有两个 —— scripts/daemon.ts 交班、
 * instrumentation.ts 网页启动时自动拉起。以前后者用 stdio:"ignore"，
 * 于是推送失败的 console.warn、启动即崩的报错，**一行都留不下**，
 * 手机收不到推送、采集没起来时完全无从查起（2026-10-08 交班事故同一个坑）。
 *
 * **不能静态 import 任何 node 模块**：instrumentation.ts 会被 Next 一并编进 edge bundle，
 * 静态引 fs/path 会构建失败（Can't resolve 'fs'）。所以和 instrumentation 一样
 * 走 process.getBuiltinModule，只在真正调用时（已确认是 nodejs runtime）才取。
 */

/**
 * 默认数据目录。**必须与 lib/config.ts 的 getConfig().dataDir 保持一致**
 * （那边静态引了 node:fs，这里用不了，只好照抄一份；tests/daemon-log.test.ts 盯着两边不漂移）。
 */
export function resolveDataDir(env: Partial<NodeJS.ProcessEnv> = process.env): string {
  if (env.PANTRADER_DATA_DIR) return env.PANTRADER_DATA_DIR;
  const path = process.getBuiltinModule("path");
  const os = process.getBuiltinModule("os");
  const home = process.platform === "win32"
    ? env.USERPROFILE ?? env.HOME ?? os.homedir()
    : env.HOME ?? os.homedir();
  return path.join(home, "PanTraderData");
}

export function daemonLogPath(dataDir: string): string {
  return process.getBuiltinModule("path").join(dataDir, "logs", "daemon.log");
}

/**
 * 以追加方式打开 daemon.log，返回可直接塞进 spawn stdio 的 fd。
 * 打不开（权限、磁盘满）就退回 "ignore" —— 日志丢了也得把进程拉起来。
 */
export function openDaemonLog(dataDir: string): number | "ignore" {
  try {
    const fs = process.getBuiltinModule("fs");
    const path = process.getBuiltinModule("path");
    const p = daemonLogPath(dataDir);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    return fs.openSync(p, "a");
  } catch {
    return "ignore";
  }
}

/** spawn 之后父进程这边的 fd 就可以关了（子进程拿到的是 dup 出来的那份） */
export function closeDaemonLog(fd: number | "ignore"): void {
  if (typeof fd !== "number") return;
  try { process.getBuiltinModule("fs").closeSync(fd); } catch { /* 已关就算了 */ }
}
