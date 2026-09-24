import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { isAlive } from "@/lib/platform/singleton";

/**
 * 停掉采集守护进程（macOS / Windows / Linux 通用）。
 *
 * 守护进程是 detached 拉起的：网页服务退出后它还在跑，所以得有一个显式的停止入口。
 *
 * 结束之前先核对身份：锁文件里的 pid 可能是上次崩溃留下的，这个号码早被系统分给了别的程序 ——
 * 不核对就结束，等于随手杀掉一个无关进程。核对办法是看它的命令行里有没有 daemon 脚本名：
 *   macOS / Linux  ps -o command= -p <pid>
 *   Windows        PowerShell Get-CimInstance Win32_Process（Windows 11 已经没有 wmic）
 *
 * 信号：先 SIGTERM。macOS / Linux 上守护进程会走自己的收尾（停调度、释放锁）；
 * Windows 没有 SIGTERM，Node 会直接终止进程、收尾代码不执行 —— 所以锁文件由这里清掉。
 * 中途打断的采集不会写坏库（SQLite WAL 崩溃安全），卡在 running 的时点下次启动由唤醒补偿回收。
 */

export const DAEMON_MARK = "daemon.ts";

export function commandLineOf(pid: number, platform: NodeJS.Platform = process.platform): string | null {
  try {
    if (platform === "win32") {
      return execFileSync("powershell.exe", [
        "-NoProfile", "-NonInteractive", "-Command",
        `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`,
      ], { encoding: "utf8", windowsHide: true, timeout: 10_000 }).trim() || null;
    }
    return execFileSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8", timeout: 10_000 }).trim() || null;
  } catch {
    return null;
  }
}

export type StopOutcome =
  | { status: "not-running"; detail: string }
  | { status: "stale-lock"; pid: number; detail: string }
  | { status: "refused"; pid: number; detail: string }
  | { status: "stopped"; pid: number; forced: boolean; detail: string }
  | { status: "failed"; pid: number; detail: string };

export interface StopOpts {
  lockPath: string;
  /** 等它自己退出的时间，超时再强制结束 */
  waitMs?: number;
  /** 测试注入 */
  cmdlineOf?: (pid: number) => string | null;
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function waitGone(pid: number, ms: number): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (!isAlive(pid)) return true;
    await sleep(200);
  }
  return !isAlive(pid);
}

function dropLock(lockPath: string, pid: number): void {
  try {
    const held = Number.parseInt(fs.readFileSync(lockPath, "utf8").trim(), 10);
    if (held === pid) fs.rmSync(lockPath);
  } catch { /* 锁已经被守护进程自己删了 */ }
}

export async function stopDaemon(o: StopOpts): Promise<StopOutcome> {
  let pid: number;
  try {
    pid = Number.parseInt(fs.readFileSync(o.lockPath, "utf8").trim(), 10);
  } catch {
    return { status: "not-running", detail: `没有锁文件 ${o.lockPath}，采集守护进程没在跑` };
  }
  if (!Number.isInteger(pid) || pid <= 0 || !isAlive(pid)) {
    try { fs.rmSync(o.lockPath); } catch { /* 删不掉也不影响下次启动：acquireLock 会接管僵尸锁 */ }
    return { status: "stale-lock", pid, detail: `锁文件里的进程 ${pid} 早已不在，已清掉残留的锁` };
  }
  const cmd = (o.cmdlineOf ?? commandLineOf)(pid);
  if (cmd === null || !cmd.includes(DAEMON_MARK)) {
    return {
      status: "refused", pid,
      detail: cmd === null
        ? `查不到进程 ${pid} 的命令行，无法确认它是采集守护进程，没有结束它`
        : `进程 ${pid} 不是采集守护进程（${cmd.slice(0, 120)}），多半是锁文件过期后号码被复用了，没有结束它`,
    };
  }
  try { process.kill(pid, "SIGTERM"); } catch (e) {
    return { status: "failed", pid, detail: `结束进程 ${pid} 失败：${(e as Error).message}` };
  }
  if (await waitGone(pid, o.waitMs ?? 10_000)) {
    dropLock(o.lockPath, pid);
    return { status: "stopped", pid, forced: false, detail: `采集守护进程 ${pid} 已停止` };
  }
  try { process.kill(pid, "SIGKILL"); } catch { /* 可能刚好自己退了 */ }
  if (await waitGone(pid, 3_000)) {
    dropLock(o.lockPath, pid);
    return { status: "stopped", pid, forced: true, detail: `采集守护进程 ${pid} 没有按时退出，已强制结束` };
  }
  return { status: "failed", pid, detail: `进程 ${pid} 强制结束后仍在，请手动处理` };
}
