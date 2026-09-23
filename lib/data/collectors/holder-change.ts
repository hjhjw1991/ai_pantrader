import type { Db } from "@/lib/db";
import type { SourceClient } from "@/lib/data/client";
import { fetchHolderChanges } from "@/lib/data/sources/eastmoney";
import { recordGap, resolveGapsForKind, today } from "@/lib/data/gap";

export interface CollectHolderChangeOpts {
  /** 公告日区间 */
  from: string;
  to: string;
  date?: string;
}

/**
 * 已实施的股东增减持，按公告日区间 upsert。
 *
 * 只 upsert 不删：这是已经发生的事实，源不会"撤回"一笔已实施的减持；
 * 偶有更正，按主键覆盖即可。
 *
 * 区间取回 0 条不记缺口：一个短窗口（节假日前后两三天）里确实可能没有公告。
 * 但方向既非增持也非减持而被丢弃的行要报出来 —— 那说明源的口径变了。
 */
export async function collectHolderChanges(
  db: Db, client: SourceClient, o: CollectHolderChangeOpts
): Promise<{ written: number; dropped: number }> {
  const date = o.date ?? today();
  let got;
  try {
    got = await fetchHolderChanges(client, o.from, o.to);
  } catch (e) {
    const msg = (e as Error).message;
    recordGap(db, date, client.source, "holder_change", `增减持 ${o.from}~${o.to} 拉取失败：${msg}`, true);
    return { written: 0, dropped: 0 };
  }
  const ins = db.prepare(
    `INSERT OR REPLACE INTO holder_change
       (code, holder, direction, start_date, end_date, notice_date,
        change_shares, change_free_ratio, after_hold_ratio, market)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  db.transaction(() => {
    for (const r of got.rows) {
      ins.run(r.code, r.holder, r.direction, r.startDate, r.endDate, r.noticeDate,
        r.changeShares, r.changeFreeRatio, r.afterHoldRatio, r.market);
    }
  })();
  const dropped = got.raw - got.rows.length;
  if (dropped > 0) {
    /**
     * 与拉取失败同一个 kind、同样可回补：回测的 hasGap(date) 不带 kind，
     * 一条永不销账的缺口会让这一天在回测里永远被跳过，代价远大于这几行本身。
     * 下一次干净的整轮会把它销掉；一直不干净，缺口就一直挂着提醒人去看。
     */
    recordGap(db, date, client.source, "holder_change",
      `增减持有 ${dropped} 行方向无法识别或代码/日期非法，源口径可能变了`, true);
  } else {
    resolveGapsForKind(db, client.source, "holder_change");
  }
  return { written: got.rows.length, dropped };
}
