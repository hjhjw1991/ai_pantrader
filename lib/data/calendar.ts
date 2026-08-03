import type { Db } from "@/lib/db";
import type { SourceClient } from "@/lib/data/client";
import { fetchSinaKlineBySymbol } from "@/lib/data/sources/sina";

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

export function latestTradingDay(db: Db, onOrBefore: string): string | null {
  const row = db.prepare(
    `SELECT date FROM trading_calendar WHERE is_open = 1 AND date <= ?
     ORDER BY date DESC LIMIT 1`
  ).get(onOrBefore) as any;
  return row?.date ?? null;
}
