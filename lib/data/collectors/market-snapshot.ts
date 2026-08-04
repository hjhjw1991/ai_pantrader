import type { Db } from "@/lib/db";
import type { SourceClient } from "@/lib/data/client";
import { fetchGtimgBatch, chunk, GTIMG_BATCH_SIZE } from "@/lib/data/sources/tencent";
import { recordGap, today } from "@/lib/data/gap";
import { shanghaiTs } from "@/lib/data/clock";

/**
 * 全市场实时快照。用 gtimg 批量接口，60 只/请求——5545 只全市场约 93 个请求。
 * 快照不可回补：错过这一刻就永久没有，所以失败必须记 gap 告警。
 */
export async function collectMarketSnapshot(
  db: Db, client: SourceClient, codes: string[]
): Promise<{ written: number; failedBatches: number }> {
  const ts = shanghaiTs();
  const stmt = db.prepare(
    `INSERT OR REPLACE INTO quote_snapshot
     (ts, code, price, pct, turnover, amplitude, bid_ask_json)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );

  let written = 0, failedBatches = 0;
  for (const batch of chunk(codes, GTIMG_BATCH_SIZE)) {
    try {
      const quotes = await fetchGtimgBatch(client, batch);
      db.transaction((qs: typeof quotes) => {
        for (const q of qs) {
          stmt.run(ts, q.code, q.price, q.pct, q.turnover, q.amplitude,
                   JSON.stringify({ o: q.open, h: q.high, l: q.low, pc: q.prevClose }));
        }
      })(quotes);
      written += quotes.length;
    } catch (e: any) {
      failedBatches++;
      recordGap(db, today(), client.source, "quote_snapshot",
                `batch of ${batch.length} failed: ${e.message}`, false);
    }
  }
  return { written, failedBatches };
}
