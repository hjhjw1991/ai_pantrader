/**
 * PIT 视图测试用的临时库。
 *
 * 为什么用真库而不是替身：PointInTimeView 的实现价值全在"SQL 有没有被 asOf 夹住"，
 * 用替身测等于测替身。所以这里开一个 mkdtemp 里的真库跑真迁移。
 * 绝不碰 ~/PanTraderData/pantrader.db —— 那份库有定时任务在写。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb, type Db } from "@/lib/db";
import { runMigrations } from "@/lib/db/migrate";

export interface TempDb {
  db: Db;
  dir: string;
  close(): void;
}

export function makeTempDb(): TempDb {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pt-pit-"));
  const db = openDb(path.join(dir, "t.db"));
  runMigrations(db);
  return {
    db, dir,
    close() {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

/* ------------------------------- 插入小工具 ------------------------------- */

export function insDaily(
  db: Db, code: string, date: string, c: number, over: Partial<{
    o: number; h: number; l: number; vol: number; amount: number; adj: number;
  }> = {}
): void {
  db.prepare(
    `INSERT OR REPLACE INTO kline_daily (code, date, o, h, l, c, vol, amount, adj_factor)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(code, date, over.o ?? c, over.h ?? c, over.l ?? c, c,
        over.vol ?? 1e6, over.amount ?? c * 1e6, over.adj ?? 1);
}

export function insMin(
  db: Db, code: string, ts: string, period: string, c: number
): void {
  db.prepare(
    `INSERT OR REPLACE INTO kline_min (code, ts, period, o, h, l, c, vol)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(code, ts, period, c, c, c, c, 1000);
}

export function insQuote(
  db: Db, code: string, ts: string, price: number,
  over: Partial<{ pct: number; turnover: number; amplitude: number }> = {}
): void {
  db.prepare(
    `INSERT OR REPLACE INTO quote_snapshot (ts, code, price, pct, turnover, amplitude, bid_ask_json)
     VALUES (?, ?, ?, ?, ?, ?, NULL)`
  ).run(ts, code, price, over.pct ?? 0, over.turnover ?? 1, over.amplitude ?? 1);
}

export function insSecurity(
  db: Db, code: string, over: Partial<{
    name: string; listDate: string | null; delistDate: string | null;
    board: string; stJson: string | null;
  }> = {}
): void {
  db.prepare(
    `INSERT OR REPLACE INTO security (code, name, list_date, delist_date, board, is_st_history_json)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(code, over.name ?? code,
        over.listDate === undefined ? "2010-01-01" : over.listDate,
        over.delistDate === undefined ? null : over.delistDate,
        over.board ?? "主板",
        over.stJson === undefined ? null : over.stJson);
}

export function insCalendar(db: Db, dates: string[], isOpen = 1): void {
  const stmt = db.prepare(
    `INSERT OR REPLACE INTO trading_calendar (date, is_open, source) VALUES (?, ?, 'test')`
  );
  db.transaction(() => { for (const d of dates) stmt.run(d, isOpen); })();
}

export function insZt(
  db: Db, date: string, code: string,
  over: Partial<{ lbc: number; sealAmt: number; openTimes: number; sector: string }> = {}
): void {
  db.prepare(
    `INSERT OR REPLACE INTO zt_pool
     (date, code, name, lbc, seal_amt, open_times, first_seal_ts, last_seal_ts, sector, turnover)
     VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?, 5)`
  ).run(date, code, code, over.lbc ?? 1, over.sealAmt ?? 1e8, over.openTimes ?? 0,
        over.sector ?? null);
}

export function insDt(db: Db, date: string, code: string, sealAmt = 1e7): void {
  db.prepare(
    `INSERT OR REPLACE INTO dt_pool (date, code, name, seal_amt) VALUES (?, ?, ?, ?)`
  ).run(date, code, code, sealAmt);
}

export function insSectorRank(
  db: Db, date: string, sector: string, pct: number,
  over: Partial<{ ts: string; leaderCode: string }> = {}
): void {
  db.prepare(
    `INSERT OR REPLACE INTO sector_rank (date, ts, sector, pct, leader_code)
     VALUES (?, ?, ?, ?, ?)`
  ).run(date, over.ts ?? `${date} 15:00:00`, sector, pct, over.leaderCode ?? null);
}

export function insLhb(
  db: Db, date: string, code: string, changeType: string, netAmt: number,
  over: Partial<{
    explanation: string; explainStat: string; buyAmt: number; sellAmt: number;
    turnoverRate: number; dealAmountRatio: number; closePrice: number;
    changeRate: number; d1: number; d5: number;
  }> = {}
): void {
  db.prepare(
    `INSERT OR REPLACE INTO lhb
     (date, code, change_type, name, explanation, explain_stat, net_amt, buy_amt, sell_amt,
      deal_amount_ratio, turnover_rate, close_price, change_rate, d1_chg, d5_chg)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(date, code, changeType, code,
        over.explanation ?? "日涨幅偏离值达到7%的前5只证券",
        over.explainStat ?? "",
        netAmt, over.buyAmt ?? Math.max(netAmt, 0), over.sellAmt ?? Math.max(-netAmt, 0),
        over.dealAmountRatio ?? null, over.turnoverRate ?? null,
        over.closePrice ?? null, over.changeRate ?? null,
        over.d1 ?? null, over.d5 ?? null);
}

export function insSeat(
  db: Db, date: string, code: string, changeType: string,
  side: "buy" | "sell", deptName: string, netAmt: number,
  over: Partial<{ deptCode: string; riseProb3d: number; buyerTimes3d: number }> = {}
): void {
  db.prepare(
    `INSERT INTO lhb_seat
     (date, code, change_type, side, dept_code, dept_name, buy_amt, sell_amt, net_amt,
      rise_prob_3d, buyer_times_3d)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(date, code, changeType, side, over.deptCode ?? "0", deptName,
        Math.max(netAmt, 0), Math.max(-netAmt, 0), netAmt,
        over.riseProb3d ?? null, over.buyerTimes3d ?? null);
}

export function insMacro(db: Db, ts: string, symbol: string, price: number, pct: number): void {
  db.prepare(
    `INSERT OR REPLACE INTO macro (ts, symbol, price, pct) VALUES (?, ?, ?, ?)`
  ).run(ts, symbol, price, pct);
}

export function insGap(
  db: Db, date: string, source: string, kind: string, resolved = false
): void {
  db.prepare(
    `INSERT OR REPLACE INTO data_gap
     (date, source, kind, reason, recoverable, detected_at, resolved_at)
     VALUES (?, ?, ?, 'test', 0, '2026-01-01T00:00:00.000Z', ?)`
  ).run(date, source, kind, resolved ? "2026-01-02T00:00:00.000Z" : null);
}
