import type { Db } from "@/lib/db";
import type { SourceClient } from "@/lib/data/client";
import {
  fetchZtPool, fetchSectorRank, fetchDtPool, fetchMacroQuote,
} from "@/lib/data/sources/eastmoney";
import { recordGap, resolveGap } from "@/lib/data/gap";
import { shanghaiTs } from "@/lib/data/clock";

/** 东财涨停池接口用 YYYYMMDD，库里统一存 YYYY-MM-DD */
const dashDate = (yyyymmdd: string) =>
  `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`;

/**
 * 涨停池。实测东财的 date 参数无效——只能拿当日，历史不可回补。
 * 所以这是纯增量资产，失败必须显式记 gap。
 */
export async function collectZtPool(
  db: Db, client: SourceClient, date: string
): Promise<number> {
  const d = dashDate(date);
  let rows;
  try {
    rows = await fetchZtPool(client, date);
  } catch (e: any) {
    recordGap(db, d, client.source, "zt_pool", e.message, false);
    throw e;
  }

  const stmt = db.prepare(
    `INSERT OR REPLACE INTO zt_pool
     (date, code, name, lbc, seal_amt, open_times, first_seal_ts, last_seal_ts, sector, turnover)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  db.transaction(() => {
    for (const r of rows) {
      stmt.run(d, r.code, r.name, r.lbc, r.sealAmt, r.openTimes,
               r.firstSealTs, r.lastSealTs, r.sector, r.turnover);
    }
  })();
  resolveGap(db, d, client.source, "zt_pool");
  return rows.length;
}

/**
 * 板块涨幅榜。
 *
 * rounds 默认 **1**（不做主机轮换重试）：轮换带 15 秒退避、最坏 45 秒，
 * 而盘中一轮采集本身就要 45 秒、5 分钟一个时点 —— 在里面重试会把整轮撑爆。
 * 盘中真正的重试是"下一轮"。收盘那次是当天最后机会，调用方会显式调大 rounds。
 *
 * 一天内多次写入，主键是 (date, ts, sector) —— 盘中每轮采集留一个时点快照，
 * 因子那边只取当天最后一个 ts（见 lib/factors/sectors.ts 的 latestRankBySector）。
 * 保留过程量是有意的：主线是"谁一直在榜上"，只留收盘那一张看不出这件事。
 */
export async function collectSectorRank(
  db: Db, client: SourceClient, date: string,
  o: { rounds?: number } = {}
): Promise<number> {
  const d = dashDate(date);
  let rows;
  try {
    rows = await fetchSectorRank(client, { rounds: o.rounds ?? 1 });
  } catch (e: any) {
    // 板块榜是盘中现场，错过就没有，与涨停池同属不可回补
    recordGap(db, d, client.source, "sector_rank", e.message, false);
    throw e;
  }

  const ts = shanghaiTs();
  const stmt = db.prepare(
    `INSERT OR REPLACE INTO sector_rank (date, ts, sector, pct, leader_code)
     VALUES (?, ?, ?, ?, ?)`
  );
  db.transaction(() => {
    for (const r of rows) stmt.run(d, ts, r.sector, r.pct, r.leaderCode);
  })();
  resolveGap(db, d, client.source, "sector_rank");
  return rows.length;
}

/**
 * 跌停池。
 *
 * 空池是合法结果，不记 gap：今天没有跌停是真实且有意义的信号
 * （择时的"跌停家数 > 30 转防守"正靠它），把它当失败会让那道闸口永远读不到"稳"。
 */
export async function collectDtPool(
  db: Db, client: SourceClient, date: string
): Promise<number> {
  const d = dashDate(date);
  let rows;
  try {
    rows = await fetchDtPool(client, date);
  } catch (e: any) {
    recordGap(db, d, client.source, "dt_pool", e.message, false);
    throw e;
  }

  const stmt = db.prepare(
    `INSERT OR REPLACE INTO dt_pool (date, code, name, seal_amt) VALUES (?, ?, ?, ?)`
  );
  db.transaction(() => {
    for (const r of rows) stmt.run(d, r.code, r.name, r.sealAmt);
  })();
  resolveGap(db, d, client.source, "dt_pool");
  return rows.length;
}

/**
 * 外围标的行情（A50 / 费半 / 黄金 / 原油）。
 *
 * 逐个标的独立成败：费半拿不到不该连累 A50 —— 外围传导因子本来就按
 * "拿到多少权重"折算置信度，缺一个它会自己降权，缺全部才判为不可用。
 * 所以这里返回 written/failed，让上层照实统计，而不是一个失败就整体抛。
 */
export async function collectMacro(
  db: Db, client: SourceClient, symbols: string[]
): Promise<{ written: number; failed: Array<{ symbol: string; error: string }> }> {
  const ts = shanghaiTs();
  const stmt = db.prepare(
    "INSERT OR REPLACE INTO macro (ts, symbol, price, pct) VALUES (?, ?, ?, ?)"
  );
  let written = 0;
  const failed: Array<{ symbol: string; error: string }> = [];

  for (const symbol of symbols) {
    try {
      const q = await fetchMacroQuote(client, symbol);
      stmt.run(ts, q.symbol, q.price, q.pct);
      written++;
    } catch (e: any) {
      failed.push({ symbol, error: e?.message ?? String(e) });
      // 记 gap 但按不可回补：外围报价是时点现场，过去某一刻的读数拿不回来
      recordGap(db, ts.slice(0, 10), client.source, `macro:${symbol}`, e?.message ?? String(e), false);
    }
  }
  return { written, failed };
}
