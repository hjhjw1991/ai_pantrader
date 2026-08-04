import fs from "node:fs";
import path from "node:path";
import { getConfig } from "@/lib/config";

/**
 * 设置页需要的"系统外部事实"：调度是否装了、日志多久没动、快照目录有多大。
 *
 * 调度状态**从磁盘读实况**（plist 文件 + 日志 mtime），不读某处配置常量：
 * 配置里写着装了、实际没装，是最容易发生也最难发现的一种失效，
 * 而它的后果是分钟线永久缺失（spec §18.2）。
 */

const AGENTS_DIR = path.join(process.env.HOME ?? "/tmp", "Library/LaunchAgents");

export interface ScheduleEntry {
  label: string;
  plistPath: string;
  /** 标准输出日志的最后写入时间。null = 日志文件不存在（可能一次都没跑过） */
  lastOutAt: string | null;
  lastErrAt: string | null;
  errBytes: number | null;
}

export interface ScheduleStatus {
  installed: boolean;
  agentsDir: string;
  logDir: string;
  entries: ScheduleEntry[];
}

function statTime(p: string): string | null {
  try {
    return fs.statSync(p).mtime.toISOString();
  } catch {
    return null;
  }
}

function statSize(p: string): number | null {
  try {
    return fs.statSync(p).size;
  } catch {
    return null;
  }
}

export function scheduleStatus(): ScheduleStatus {
  const logDir = path.join(getConfig().dataDir, "logs");
  let names: string[] = [];
  try {
    names = fs
      .readdirSync(AGENTS_DIR)
      .filter((f) => f.startsWith("com.pantrader.") && f.endsWith(".plist"));
  } catch {
    names = [];
  }
  const entries = names.map((f) => {
    const label = f.replace(/\.plist$/, "");
    return {
      label,
      plistPath: path.join(AGENTS_DIR, f),
      lastOutAt: statTime(path.join(logDir, `${label}.out.log`)),
      lastErrAt: statTime(path.join(logDir, `${label}.err.log`)),
      errBytes: statSize(path.join(logDir, `${label}.err.log`)),
    };
  });
  return { installed: entries.length > 0, agentsDir: AGENTS_DIR, logDir, entries };
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
