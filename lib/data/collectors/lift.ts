import type { Db } from "@/lib/db";
import type { SourceClient } from "@/lib/data/client";
import { fetchLiftSchedule } from "@/lib/data/sources/eastmoney";
import { recordGap, resolveGapsForKind, today } from "@/lib/data/gap";

export interface CollectLiftOpts {
  from: string;
  to: string;
  /** 记缺口用的日期 */
  date?: string;
}

/**
 * 解禁日历采集：按解禁日窗口全量重拉，窗口内先删后插。
 *
 * 先删后插是因为东财会**撤掉**记录（解禁延期、承诺延长锁定），只做 upsert 的话，
 * 已经不会发生的解禁会永远留在表里，把一只票判成"下个月有大额解禁"。
 *
 * 但删只发生在**整窗拉取成功之后**，且与插入同一个事务。拉失败时清空窗口，
 * 等于宣称"这段时间没有解禁" —— 那比数据旧更危险，因为它会让一只真要解禁的票
 * 看起来很安全。
 */
export async function collectLiftSchedule(
  db: Db, client: SourceClient, o: CollectLiftOpts
): Promise<{ written: number }> {
  const date = o.date ?? today();

  let rows;
  try {
    rows = await fetchLiftSchedule(client, o.from, o.to);
  } catch (e) {
    const msg = (e as Error).message;
    // 可回补：解禁日历是事先定好的，明天重拉拿到的还是同一份历史
    recordGap(db, date, client.source, "lift_schedule", `解禁日历拉取失败：${msg}`, true);
    return { written: 0 };
  }

  if (rows.length === 0) {
    // 全市场一个宽窗口里零解禁不可能（实测全表 3 万多行），多半是限流或结构变了
    recordGap(db, date, client.source, "lift_schedule",
      `解禁日历 ${o.from}~${o.to} 取回 0 条，多半是限流`, true);
    return { written: 0 };
  }

  const del = db.prepare("DELETE FROM lift_schedule WHERE free_date >= ? AND free_date <= ?");
  const ins = db.prepare(
    `INSERT OR REPLACE INTO lift_schedule
       (code, free_date, share_type, free_shares, lift_mktcap, free_ratio, total_ratio)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  db.transaction(() => {
    del.run(o.from, o.to);
    for (const r of rows) {
      ins.run(r.code, r.freeDate, r.shareType, r.freeShares, r.liftMktcap, r.freeRatio, r.totalRatio);
    }
  })();

  // 整份日历重拉成功 = 以前任何一次失败都被覆盖了，跨日期销账
  resolveGapsForKind(db, client.source, "lift_schedule");
  return { written: rows.length };
}
