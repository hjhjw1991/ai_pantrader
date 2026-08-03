import type { Db } from "@/lib/db";
import type { SourceClient } from "@/lib/data/client";
import { fetchZtPool } from "@/lib/data/sources/eastmoney";
import { recordGap, resolveGap } from "@/lib/data/gap";

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
