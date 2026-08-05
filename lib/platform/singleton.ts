import fs from "node:fs";
import path from "node:path";

/**
 * 跨平台单实例锁（PID 文件）。
 *
 * 为什么需要：采集守护进程可能被多个入口拉起 —— 网页服务启动时、用户手敲
 * `pnpm daemon`、开发模式热重载。重复拉起的后果不只是浪费：几个免费源都很容易
 * 限频（实测东财十几次请求就整体掉线），两个进程同时拉 5888 只快照会互相把对方打挂。
 *
 * job_run 表已经做了"同一时点只执行一次"的去重，这把锁解决的是更前一层：
 * 别让多余的进程活着。
 *
 * 用 PID 文件而不是端口占用：不需要监听端口，且 Windows/macOS/Linux 行为一致。
 * 存活判定用 `process.kill(pid, 0)` —— 不发信号只做权限/存在性检查，三个平台的
 * Node 都实现了。
 */

export interface LockResult {
  acquired: boolean;
  /** 已持有锁的进程 pid（acquired=false 时有意义） */
  heldBy?: number;
  path: string;
}

export function isAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    // EPERM = 进程存在但不属于当前用户，仍算活着
    return e?.code === "EPERM";
  }
}

/**
 * 尝试取锁。已有活进程持锁则返回 acquired:false；
 * 锁文件是上次崩溃留下的僵尸（进程已死）则直接接管。
 */
export function acquireLock(lockPath: string, pid: number = process.pid): LockResult {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });

  if (fs.existsSync(lockPath)) {
    const raw = fs.readFileSync(lockPath, "utf8").trim();
    const held = Number.parseInt(raw, 10);
    if (isAlive(held) && held !== pid) {
      return { acquired: false, heldBy: held, path: lockPath };
    }
    // 陈旧锁：进程没了。直接覆盖，否则崩一次就再也起不来
  }

  fs.writeFileSync(lockPath, String(pid), "utf8");
  return { acquired: true, path: lockPath };
}

/** 释放锁。只删自己写的那把，避免误删别人接管后的锁 */
export function releaseLock(lockPath: string, pid: number = process.pid): void {
  try {
    if (!fs.existsSync(lockPath)) return;
    const held = Number.parseInt(fs.readFileSync(lockPath, "utf8").trim(), 10);
    if (held === pid) fs.rmSync(lockPath);
  } catch { /* 释放失败不该影响退出流程 */ }
}
