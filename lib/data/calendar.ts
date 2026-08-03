import type { Db } from "@/lib/db";
import type { SourceClient } from "@/lib/data/client";
import { fetchSinaKlineBySymbol } from "@/lib/data/sources/sina";
import { probeTradingDay } from "@/lib/data/sources/tencent";

// 上证指数。必须用完整 symbol：sinaSymbol("000001") 会算成 sz000001（平安银行），
// 个股会停牌，拿它当日历会漏交易日。
const INDEX_SYMBOL = "sh000001";

export async function syncCalendar(
  db: Db, client: SourceClient, datalen = 1023
): Promise<number> {
  const bars = await fetchSinaKlineBySymbol(client, INDEX_SYMBOL, 240, datalen);
  const stmt = db.prepare(
    `INSERT INTO trading_calendar (date, is_open, source) VALUES (?, 1, 'sina_index')
     ON CONFLICT(date) DO UPDATE SET is_open = 1, source = 'sina_index'`
  );
  const dates = bars.map(b => b.ts.slice(0, 10));
  db.transaction((rows: string[]) => { for (const d of rows) stmt.run(d); })(dates);
  return dates.length;
}

export function isTradingDay(db: Db, date: string): boolean {
  const row = db.prepare("SELECT is_open FROM trading_calendar WHERE date = ?").get(date) as any;
  return row?.is_open === 1;
}

export function tradingDaysBetween(db: Db, from: string, to: string): string[] {
  return db.prepare(
    `SELECT date FROM trading_calendar
     WHERE is_open = 1 AND date >= ? AND date <= ? ORDER BY date`
  ).all(from, to).map((r: any) => r.date);
}

/**
 * 判断某日是否开市，表里没有记录时用实时行情兜底并回写。
 *
 * 必要性：日历由日线生成，当日日线收盘后才有。盘中直接查表会得到
 * 「非交易日」，导致 09:35–14:55 的所有 job 全部跳过。
 * 只对「今天」做兜底——历史日期没记录就是真没开市。
 */
export async function ensureTradingDay(
  db: Db, client: SourceClient, date: string, isToday: boolean
): Promise<boolean> {
  const row = db.prepare("SELECT is_open FROM trading_calendar WHERE date = ?").get(date) as any;
  if (row) return row.is_open === 1;
  if (!isToday) return false;

  const open = await probeTradingDay(client, date.replace(/-/g, ""));
  db.prepare(
    `INSERT INTO trading_calendar (date, is_open, source) VALUES (?, ?, 'gtimg_probe')
     ON CONFLICT(date) DO UPDATE SET is_open = excluded.is_open, source = 'gtimg_probe'`
  ).run(date, open ? 1 : 0);
  return open;
}

export function latestTradingDay(db: Db, onOrBefore: string): string | null {
  const row = db.prepare(
    `SELECT date FROM trading_calendar WHERE is_open = 1 AND date <= ?
     ORDER BY date DESC LIMIT 1`
  ).get(onOrBefore) as any;
  return row?.date ?? null;
}
