import type { Db } from "@/lib/db";
import type { SourceClient } from "@/lib/data/client";
import { fetchSinaKlineBySymbol } from "@/lib/data/sources/sina";
import { probeTradingDay } from "@/lib/data/sources/tencent";
import { shanghaiTs } from "@/lib/data/clock";

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
/**
 * 实时行情探测的**负面**结论在这个时刻之前不可信。
 *
 * 2026-08-04 的真实事故：preopen 09:00 跑探测，此时集合竞价（09:15）还没开始，
 * gtimg 的行情时间戳仍停在上一场，探测于是判"今天不是交易日"，
 * 并把 is_open=0 当权威结论写进日历。之后 09:35~14:55 每一个 intraday job
 * 读到这行缓存直接跳过 —— 全市场快照是不可回补的，一上午就这么没了。
 *
 * 底层错误是把"现在还看不出来"和"今天真的休市"当成了同一件事。
 * 开盘后仍停在上一场才说明是休市，之前只能算未知。
 */
export const PROBE_TRUST_AFTER = "09:35";

/** 周末是不需要探测就能确定的休市，省一次请求也省一次误判机会 */
function isWeekend(date: string): boolean {
  const d = new Date(`${date}T00:00:00Z`).getUTCDay();
  return d === 0 || d === 6;
}

function writeCalendar(db: Db, date: string, open: boolean, source: string): void {
  db.prepare(
    `INSERT INTO trading_calendar (date, is_open, source) VALUES (?, ?, ?)
     ON CONFLICT(date) DO UPDATE SET is_open = excluded.is_open, source = excluded.source`
  ).run(date, open ? 1 : 0, source);
}

export async function ensureTradingDay(
  db: Db, client: SourceClient, date: string, isToday: boolean,
  now: Date = new Date()
): Promise<boolean> {
  const row = db.prepare(
    "SELECT is_open, source FROM trading_calendar WHERE date = ?"
  ).get(date) as { is_open: number; source: string | null } | undefined;

  // 日线反推出来的日历是权威的，直接采信
  if (row && row.source !== "gtimg_probe") return row.is_open === 1;
  // 探测的正面结论可信（行情时间戳确实是今天，不可能是别的原因）
  if (row && row.is_open === 1) return true;
  // 落到这里说明只有"探测说没开"这一条缓存 —— 它可能是开盘前写坏的，必须重探
  if (!isToday) return row ? row.is_open === 1 : false;

  if (isWeekend(date)) {
    writeCalendar(db, date, false, "weekend");
    return false;
  }

  const open = await probeTradingDay(client, date.replace(/-/g, ""));
  if (open) {
    writeCalendar(db, date, true, "gtimg_probe");
    return true;
  }

  // 负面结论只有过了开盘时点才敢落库；在那之前不写，留给后面的 job 重探
  const hm = shanghaiTs(now).slice(11, 16);
  if (hm >= PROBE_TRUST_AFTER) writeCalendar(db, date, false, "gtimg_probe");
  return false;
}

export function latestTradingDay(db: Db, onOrBefore: string): string | null {
  const row = db.prepare(
    `SELECT date FROM trading_calendar WHERE is_open = 1 AND date <= ?
     ORDER BY date DESC LIMIT 1`
  ).get(onOrBefore) as any;
  return row?.date ?? null;
}
