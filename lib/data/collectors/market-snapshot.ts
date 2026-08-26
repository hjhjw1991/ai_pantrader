import type { Db } from "@/lib/db";
import type { SourceClient } from "@/lib/data/client";
import { fetchGtimgBatch, chunk, GTIMG_BATCH_SIZE } from "@/lib/data/sources/tencent";
import { recordGap, today } from "@/lib/data/gap";
import { shanghaiTs } from "@/lib/data/clock";

/**
 * 全市场实时快照。用 gtimg 批量接口，60 只/请求——5545 只全市场约 93 个请求。
 * 快照不可回补：错过这一刻就永久没有，所以失败必须记 gap 告警。
 */
/** 批次进度。手动采集要给用户画进度条 —— 一轮 45 秒，没有进度就只能盯着转圈猜 */
export interface SnapshotProgress {
  /** 已完成的批次（成功+失败都算，进度条要单调递增） */
  done: number;
  total: number;
  written: number;
  failedBatches: number;
}

export async function collectMarketSnapshot(
  db: Db, client: SourceClient, codes: string[],
  onProgress?: (p: SnapshotProgress) => void
): Promise<{ written: number; failedBatches: number }> {
  const ts = shanghaiTs();
  const stmt = db.prepare(
    `INSERT OR REPLACE INTO quote_snapshot
     (ts, code, price, pct, turnover, amplitude, bid_ask_json)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );

  let written = 0, failedBatches = 0;
  const batches = [...chunk(codes, GTIMG_BATCH_SIZE)];
  let done = 0;
  for (const batch of batches) {
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
    // 失败的批次也要报进度：进度条卡住会被当成程序挂了，而失败批次数就在同一条消息里
    done++;
    onProgress?.({ done, total: batches.length, written, failedBatches });
  }
  return { written, failedBatches };
}
