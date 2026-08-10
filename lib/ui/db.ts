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
 * 拿不到库的两种原因。**必须分开**：
 *
 * - missing    —— 文件真的不在，处置是建库灌数据；
 * - unopenable —— 文件在，但连不上（原生模块 ABI 不匹配、权限、文件损坏……），
 *                 处置是修环境，跟建库毫无关系。
 *
 * 这个区分是踩过坑补的：Node 从 22 升到 24 之后 better-sqlite3 的预编译
 * .node 还是 ABI 127，构造函数直接 ERR_DLOPEN_FAILED。当时这里一个
 * `catch { return null }` 把它压成了"数据库不存在"，人被文案带着去查路径，
 * 而路径从头到尾都是对的。**故障信息说错话，比不说话更贵。**
 */
export type DbUnavailable =
  | { kind: "missing"; path: string }
  | { kind: "unopenable"; path: string; detail: string };

export type ReadDbResult =
  | { ok: true; db: Database.Database }
  | { ok: false; why: DbUnavailable };

/**
 * 只读连接，带失败原因。
 * 调用方必须渲染空态，不许把失败当成"数据为空" —— 两者的处置动作完全不同。
 */
export function openRead(p: string = dbPath()): ReadDbResult {
  const hit = cache.get(p);
  if (hit && hit.open) return { ok: true, db: hit };
  if (!fs.existsSync(p)) return { ok: false, why: { kind: "missing", path: p } };
  try {
    const db = new Database(p, { readonly: true, fileMustExist: true });
    db.pragma("busy_timeout = 3000");
    cache.set(p, db);
    return { ok: true, db };
  } catch (e) {
    // 原始 message 原样带出，不改写、不截断：ABI 号、errno 全在里面，是唯一线索
    const detail = e instanceof Error ? e.message : String(e);
    return { ok: false, why: { kind: "unopenable", path: p, detail } };
  }
}

/** 旧签名保留：绝大多数调用方只关心"有没有连上" */
export function readDb(p: string = dbPath()): Database.Database | null {
  const r = openRead(p);
  return r.ok ? r.db : null;
}

/**
 * 供空态/错误响应取失败原因。重新探测一次而不是缓存上次的错误 ——
 * 缓存住的错误会在人修好环境之后继续撒谎。
 */
export function dbUnavailable(p: string = dbPath()): DbUnavailable {
  const r = openRead(p);
  if (r.ok) return { kind: "unopenable", path: p, detail: "重新探测时已可打开，请刷新" };
  return r.why;
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
