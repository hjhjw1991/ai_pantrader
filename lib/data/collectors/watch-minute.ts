import type { Db } from "@/lib/db";
import type { SourceClient } from "@/lib/data/client";
import { fetchSinaKline, SourceNoData } from "@/lib/data/sources/sina";
import { recordGap, today } from "@/lib/data/gap";

/**
 * 关注池分钟线。新浪分钟线是单票单请求且无 end-date 参数，
 * 只能拿最近 N 根——不可回补，缺一天永久缺一天。
 * 因此只对持仓+观察池（约 50 只）抓，不做全市场。
 */
export async function collectWatchMinute(
  db: Db, client: SourceClient, codes: string[], scale: 5 = 5
): Promise<{ written: number; failed: string[]; noData: string[] }> {
  const stmt = db.prepare(
    `INSERT OR REPLACE INTO kline_min (code, ts, period, o, h, l, c, vol)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );
  let written = 0; const failed: string[] = []; const noData: string[] = [];

  for (const code of codes) {
    try {
      const bars = await fetchSinaKline(client, code, scale, 240);
      db.transaction(() => {
        for (const b of bars) stmt.run(code, b.ts, `m${scale}`, b.o, b.h, b.l, b.c, b.vol);
      })();
      written += bars.length;
    } catch (e: any) {
      if (e instanceof SourceNoData) {
        // 源上没有这条分钟序列（退市/PT 代码，实测 000003/000013/000015/000047）。
        // 记成缺口的后果比日线那次更糟：分钟线是不可回补的，
        // recoverable=0 的缺口永远不会消失，会一直挂在"不可恢复缺口"告警里 ——
        // 而那个告警本该只在真丢了盘中数据时响。
        noData.push(code);
        continue;
      }
      failed.push(code);
      recordGap(db, today(), client.source, `kline_min:${code}`, e.message, false);
    }
  }
  return { written, failed, noData };
}
