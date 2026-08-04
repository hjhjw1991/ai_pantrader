import type { Db } from "@/lib/db";
import { shanghaiTs } from "@/lib/data/clock";

export function getMeta(db: Db, key: string): string | null {
  const r = db.prepare("SELECT value FROM app_meta WHERE key = ?").get(key) as any;
  return r?.value ?? null;
}

export function setMeta(db: Db, key: string, value: string): void {
  db.prepare(
    `INSERT INTO app_meta (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  ).run(key, value, shanghaiTs());
}

/**
 * 缺口检测的起算日。系统上线之前的历史不该算作缺口——
 * 不可回补的数据（分钟线/涨停池/板块榜）在上线前本来就不存在。
 * 首次调用时以当天写入并返回。
 */
export function systemStartDate(db: Db, today: string): string {
  const existing = getMeta(db, "system_start_date");
  if (existing) return existing;
  setMeta(db, "system_start_date", today);
  return today;
}
