import type { Db } from "@/lib/db";
import type { SourceClient } from "@/lib/data/client";
import { fetchSinaKline } from "@/lib/data/sources/sina";
import { recordGap, today } from "@/lib/data/gap";

/**
 * 关注池分钟线。新浪分钟线是单票单请求且无 end-date 参数，
 * 只能拿最近 N 根——不可回补，缺一天永久缺一天。
 * 因此只对持仓+观察池（约 50 只）抓，不做全市场。
 */
export async function collectWatchMinute(
  db: Db, client: SourceClient, codes: string[], scale: 5 = 5
): Promise<{ written: number; failed: string[] }> {
  const stmt = db.prepare(
    `INSERT OR REPLACE INTO kline_min (code, ts, period, o, h, l, c, vol)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );
  let written = 0; const failed: string[] = [];

  for (const code of codes) {
    try {
      const bars = await fetchSinaKline(client, code, scale, 240);
      db.transaction(() => {
        for (const b of bars) stmt.run(code, b.ts, `m${scale}`, b.o, b.h, b.l, b.c, b.vol);
      })();
      written += bars.length;
    } catch (e: any) {
      failed.push(code);
      recordGap(db, today(), client.source, `kline_min:${code}`, e.message, false);
    }
  }
  return { written, failed };
}
