import fs from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";
import { getConfig } from "@/lib/config";
import { isAlive } from "@/lib/platform/singleton";

/**
 * 设置页需要的"系统外部事实"：采集守护进程在不在跑、各任务最近一次跑得怎样、数据目录有多大。
 *
 * 调度状态**读实况**（PID 锁 + 进程存活 + job_run），不读某处配置常量：
 * 以为在跑、实际没跑，是最容易发生也最难发现的一种失效，而它的后果是分钟线永久缺失（spec §18.2）。
 *
 * 以前这里读的是 ~/Library/LaunchAgents 里的 plist。系统现在只靠进程内调度（换电脑能跟着走），
 * launchd 已经拆掉，再读那个目录只会永远报"未安装"。
 */

export interface JobLast {
  job: string;
  date: string;
  slot: string;
  status: string;
  runner: string | null;
  finishedAt: string | null;
  error: string | null;
}

export interface ScheduleStatus {
  /** 守护进程是否活着（PID 锁里的进程还在） */
  running: boolean;
  pid: number | null;
  lockPath: string;
  /** 每个任务最近一次的记录 */
  jobs: JobLast[];
}

export function scheduleStatus(db: Database.Database | null): ScheduleStatus {
  const lockPath = path.join(getConfig().dataDir, "scheduler.pid");
  let pid: number | null = null;
  try { pid = Number.parseInt(fs.readFileSync(lockPath, "utf8").trim(), 10) || null; } catch { pid = null; }
  const jobs = db === null ? [] : (db.prepare(
    `SELECT job, date, slot, status, runner, finished_at, error FROM job_run j
      WHERE (date || ' ' || slot) = (SELECT MAX(date || ' ' || slot) FROM job_run k WHERE k.job = j.job)
      ORDER BY job`
  ).all() as any[]).map(r => ({
    job: r.job, date: r.date, slot: r.slot, status: r.status, runner: r.runner, finishedAt: r.finished_at, error: r.error,
  }));
  return { running: pid !== null && isAlive(pid), pid, lockPath, jobs };
}

function statSize(p: string): number | null {
  try {
    return fs.statSync(p).size;
  } catch {
    return null;
  }
}

export interface StorageInfo {
  dataDir: string;
  dbPath: string;
  dbBytes: number | null;
  /** WAL 文件。异常巨大说明有连接长期不 checkpoint */
  walBytes: number | null;
  snapshotDir: string;
  snapshotCount: number | null;
  bakFiles: Array<{ name: string; bytes: number; mtime: string }>;
}

export function storageInfo(): StorageInfo {
  const cfg = getConfig();
  let snapshotCount: number | null = null;
  try {
    snapshotCount = fs.readdirSync(cfg.snapshotDir).length;
  } catch {
    snapshotCount = null;
  }
  let bakFiles: StorageInfo["bakFiles"] = [];
  try {
    bakFiles = fs
      .readdirSync(cfg.dataDir)
      .filter((f) => f.endsWith(".ptbak"))
      .map((f) => {
        const st = fs.statSync(path.join(cfg.dataDir, f));
        return { name: f, bytes: st.size, mtime: st.mtime.toISOString() };
      })
      .sort((a, b) => (a.mtime < b.mtime ? 1 : -1));
  } catch {
    bakFiles = [];
  }
  return {
    dataDir: cfg.dataDir,
    dbPath: cfg.dbPath,
    dbBytes: statSize(cfg.dbPath),
    walBytes: statSize(`${cfg.dbPath}-wal`),
    snapshotDir: cfg.snapshotDir,
    snapshotCount,
    bakFiles,
  };
}
