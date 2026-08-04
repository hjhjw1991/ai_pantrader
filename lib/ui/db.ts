import fs from "node:fs";
import Database from "better-sqlite3";
import { getConfig } from "@/lib/config";
import { openDb, type Db } from "@/lib/db";

/**
 * 前端的 DB 连接。
 *
 * 读走独立的 readonly 连接，不复用 lib/db 的 openDb —— 后者没有 readonly 选项，
 * 而 launchd 定时 job 每几分钟就在往这个库里写。前端只读，就不该去争写锁：
 * readonly 连接拿不到写锁，也就不可能因为一个页面刷新把采集写入挤掉。
 * （openDb 属于别的层，不能改，所以这里直接构造。写路径仍然走 openDb。）
 *
 * busy_timeout：WAL 下读不阻塞写，但 checkpoint 期间仍可能短暂 SQLITE_BUSY，
 * 给 3 秒重试窗口比让页面 500 好。
 */

const g = globalThis as unknown as {
  __pantraderRead?: Map<string, Database.Database>;
};
// dev 下模块会被 HMR 重复求值，连接挂在 globalThis 上才不会每次热更都泄一个句柄
const cache = (g.__pantraderRead ??= new Map());

export function dbPath(): string {
  return getConfig().dbPath;
}

export function dbExists(p: string = dbPath()): boolean {
  return fs.existsSync(p);
}

/**
 * 只读连接。库不存在时返回 null —— 调用方必须渲染"数据库不存在"的空态，
 * 不许把它当成"数据为空"，两者的处置动作完全不同。
 */
export function readDb(p: string = dbPath()): Database.Database | null {
  const hit = cache.get(p);
  if (hit && hit.open) return hit;
  if (!fs.existsSync(p)) return null;
  try {
    const db = new Database(p, { readonly: true, fileMustExist: true });
    db.pragma("busy_timeout = 3000");
    cache.set(p, db);
    return db;
  } catch {
    return null;
  }
}

/**
 * 写连接。只有三处会用到：观察池增删、手工成交回填、策略元数据。
 * 行情/截面数据一律由 launchd job 写，前端永不写。
 */
export function writeDb(p?: string): Db {
  return openDb(p);
}

/** 已应用的 migration 列表，设置页要显示 schema 版本 */
export function appliedMigrations(db: Database.Database): string[] {
  try {
    return db
      .prepare("SELECT name FROM _migrations ORDER BY name")
      .all()
      .map((r) => (r as { name: string }).name);
  } catch {
    return [];
  }
}
