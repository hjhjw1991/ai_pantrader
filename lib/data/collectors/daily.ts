import type { Db } from "@/lib/db";
import type { SourceClient } from "@/lib/data/client";
import { fetchSinaKline } from "@/lib/data/sources/sina";
import { recordGap, today } from "@/lib/data/gap";

/**
 * 日线。可回补（新浪 scale=240 一次 1023 根，约到 2022-05），
 * 所以失败记的是 recoverable gap，夜间 job 会重来。
 * 注：新浪日线不复权，adj_factor 保留既有值（默认 1.0），
 * 复权因子计算属于 M0 之外（见 spec R1）。
 */
export async function collectDaily(
  db: Db, client: SourceClient, codes: string[], datalen: number
): Promise<{ written: number; failed: string[] }> {
  const stmt = db.prepare(
    `INSERT OR REPLACE INTO kline_daily (code, date, o, h, l, c, vol, amount, adj_factor)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, COALESCE(
       (SELECT adj_factor FROM kline_daily WHERE code = ? AND date = ?), 1.0))`
  );
  let written = 0; const failed: string[] = [];

  for (const code of codes) {
    try {
      const bars = await fetchSinaKline(client, code, 240, datalen);
      db.transaction(() => {
        for (const b of bars) {
          const d = b.ts.slice(0, 10);
          stmt.run(code, d, b.o, b.h, b.l, b.c, b.vol, null, code, d);
        }
      })();
      written += bars.length;
    } catch (e: any) {
      failed.push(code);
      recordGap(db, today(), client.source, `kline_daily:${code}`, e.message, true);
    }
  }
  return { written, failed };
}
