import type { Db } from "@/lib/db";
import type { SourceClient } from "@/lib/data/client";
import {
  fetchZtPool, fetchSectorRank, fetchDtPool, fetchMacroQuote, fetchSectorMembers,
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

/**
 * 全市场 代码 → 行业板块 映射。
 *
 * 逐个行业拉成分股。行业数约 106，每个一个请求 —— 这是本项目对东财最重的一次调用，
 * 所以**不每天跑**：行业归属只在并购、主业变更时才动，按"整张表多久没更新过"判，
 * 默认 7 天一次，放在夜间 job（那时没人等结果，且限流影响不到盘中采集）。
 *
 * 部分失败照样写入已拿到的部分并如实报数：拿到 90 个行业的映射，
 * 比因为 16 个失败就整批丢弃有用得多 —— 缺的那部分下次刷新时补，
 * 而映射缺失的票在策略层会被主线筛挡下（那是"未判定不等于通过"，不是错判）。
 */
export async function collectSectorMembers(
  db: Db, client: SourceClient, sectors: Array<{ bk: string; sector: string }>
): Promise<{ sectors: number; codes: number; failed: string[] }> {
  const ts = shanghaiTs();
  const stmt = db.prepare(
    "INSERT OR REPLACE INTO security_sector (code, sector, bk, ts) VALUES (?, ?, ?, ?)"
  );
  let codes = 0, done = 0;
  const failed: string[] = [];

  for (const s of sectors) {
    try {
      const members = await fetchSectorMembers(client, s.bk, { rounds: 1 });
      db.transaction(() => {
        for (const m of members) stmt.run(m.code, s.sector, s.bk, ts);
      })();
      codes += members.length;
      done++;
    } catch (e: any) {
      failed.push(`${s.sector}(${s.bk})`);
    }
  }
  if (failed.length > 0) {
    recordGap(db, ts.slice(0, 10), client.source, "security_sector",
      `${failed.length}/${sectors.length} 个行业成分拉取失败：${failed.slice(0, 5).join(", ")}` +
      (failed.length > 5 ? " …" : ""), true);
  } else {
    resolveGap(db, ts.slice(0, 10), client.source, "security_sector");
  }
  return { sectors: done, codes, failed };
}

/** 映射表最后一次更新是什么时候（上海挂钟串）。空表返回 null */
export function sectorMembersUpdatedAt(db: Db): string | null {
  const r = db.prepare("SELECT MAX(ts) AS t FROM security_sector").get() as { t: string | null };
  return r.t ?? null;
}

/**
 * 取当前的行业板块清单（bk + 名称），供成分股拉取使用。
 * 与 collectSectorRank 共用同一个接口，但**不写库** —— 这里要的是清单，不是当日涨幅快照。
 */
export async function collectSectorRankList(
  db: Db, client: SourceClient
): Promise<Array<{ bk: string; sector: string }>> {
  // 必须翻页：接口单页上限 100，而行业总数实测 496。
  // 只拿第一页会让三分之二的票查不到行业，然后被主线筛静默挡掉。
  const rows = await fetchSectorRank(client, { rounds: 3, allPages: true });
  return rows
    .filter(r => r.bk.length > 0)
    .map(r => ({ bk: r.bk, sector: r.sector }));
}
