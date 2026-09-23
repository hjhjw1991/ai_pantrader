import type { Db } from "@/lib/db";
import type { SourceClient } from "@/lib/data/client";
import { fetchMutualDeal, fetchMutualTop10 } from "@/lib/data/sources/eastmoney";
import { recordGap, resolveGapsForKind, today } from "@/lib/data/gap";

export interface CollectMutualOpts {
  from: string;
  to: string;
  date?: string;
}

/**
 * 互联互通成交与北向十大成交股，按日期区间 upsert。
 *
 * 不做逐日完整性检查：港股休市时沪深港通也停，而那些天 A 股照常开盘 ——
 * 拿 A 股日历去查"哪天缺了北向"会把每个港股假期都报成缺口。
 * 所以这里只对**拉取失败**记缺口；空区间（例如整段港股假期）是合法的。
 */
export async function collectMutual(
  db: Db, client: SourceClient, o: CollectMutualOpts
): Promise<{ dealRows: number; top10Rows: number }> {
  const date = o.date ?? today();
  let deal, top;
  try {
    deal = await fetchMutualDeal(client, o.from, o.to);
    top = await fetchMutualTop10(client, o.from, o.to);
  } catch (e) {
    const msg = (e as Error).message;
    recordGap(db, date, client.source, "mutual", `互联互通 ${o.from}~${o.to} 拉取失败：${msg}`, true);
    return { dealRows: 0, top10Rows: 0 };
  }
  const insD = db.prepare(
    `INSERT OR REPLACE INTO mutual_deal (date, mutual_type, deal_amt, net_amt) VALUES (?, ?, ?, ?)`
  );
  const insT = db.prepare(
    `INSERT OR REPLACE INTO mutual_top10 (date, mutual_type, code, rank, deal_amt, mutual_ratio)
     VALUES (?, ?, ?, ?, ?, ?)`
  );
  db.transaction(() => {
    for (const r of deal) insD.run(r.date, r.mutualType, r.dealAmt, r.netAmt);
    // 十大成交按日整批替换：名单每天就这 20 只，旧名单里掉出去的不能留着
    const days = [...new Set(top.map(r => r.date))];
    const del = db.prepare("DELETE FROM mutual_top10 WHERE date = ?");
    for (const d of days) del.run(d);
    for (const r of top) insT.run(r.date, r.mutualType, r.code, r.rank, r.dealAmt, r.mutualRatio);
  })();
  resolveGapsForKind(db, client.source, "mutual");
  return { dealRows: deal.length, top10Rows: top.length };
}
