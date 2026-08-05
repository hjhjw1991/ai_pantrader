import type { Db } from "@/lib/db";
import type { SourceClient } from "@/lib/data/client";
import { fetchSinaKline, SourceNoData } from "@/lib/data/sources/sina";
import { recordGap, resolveGap, today } from "@/lib/data/gap";

/**
 * 关注池分钟线。新浪分钟线是单票单请求且无 end-date 参数，只能拿最近 240 根。
 * 因此只对持仓+观察池（约 50 只）抓，不做全市场。
 *
 * 可回补性要分两种情况，早期版本混成了一种（一律 recoverable=0），
 * 结果一次限频就留下 50 条永远消不掉的缺口，把真正的告警淹掉：
 *   窗口内的瞬时失败 —— **可回补**。下一轮成功采集会把这 240 根一并带回来，
 *                       所以标 recoverable=1，并在下次成功时主动 resolve。
 *   整天没采（机器关着）—— 才是永久丢失，那由 selfcheck 的 slotCoverage 反映。
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
      // 这一轮拿到了 240 根，之前那次失败留下的缺口已被本轮覆盖
      resolveGap(db, today(), client.source, `kline_min:${code}`);
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
      // recoverable=1：窗口内的失败下一轮就能补回来
      recordGap(db, today(), client.source, `kline_min:${code}`, e.message, true);
    }
  }
  return { written, failed, noData };
}
