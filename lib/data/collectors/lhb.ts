import type { Db } from "@/lib/db";
import type { SourceClient } from "@/lib/data/client";
import { fetchLhb } from "@/lib/data/sources/eastmoney";
import { recordGap, resolveGap } from "@/lib/data/gap";

/**
 * 龙虎榜。实测可按历史日期回补，且自带 D1/D5/D10 后续涨跌幅
 * （天然的监督标签），所以失败记 recoverable gap 交给回补流程。
 */
export async function collectLhb(
  db: Db, client: SourceClient, date: string
): Promise<number> {
  let rows;
  try {
    rows = await fetchLhb(client, date);
  } catch (e: any) {
    recordGap(db, date, client.source, "lhb", e.message, true);
    throw e;
  }

  const stmt = db.prepare(
    `INSERT OR REPLACE INTO lhb
     (date, code, name, net_amt, buy_amt, sell_amt, explanation, d1_chg, d5_chg, d10_chg)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  db.transaction(() => {
    for (const r of rows) {
      stmt.run(r.date, r.code, r.name, r.netAmt, r.buyAmt, r.sellAmt,
               r.explanation, r.d1Chg, r.d5Chg, r.d10Chg);
    }
  })();
  resolveGap(db, date, client.source, "lhb");
  return rows.length;
}
