import type { Db } from "@/lib/db";
import type { SourceClient } from "@/lib/data/client";
import { fetchSinaKline, SourceNoData } from "@/lib/data/sources/sina";
import { recordGap, today } from "@/lib/data/gap";

/**
 * 无序列代码占比的告警阈值。
 *
 * 单只票没有 K 线是正常的（新股、定向转让代码），但限频也可能表现成大面积无数据。
 * 两者靠"是不是一小撮"来区分：实测正常水位是 14/5888 ≈ 0.24%。
 * 超过 5% 就不再当"正常缺序列"，记缺口告警 —— 宁可误报，不可把一次限频
 * 事故当成"这 3000 只票本来就没数据"咽下去。
 */
const NO_DATA_ALERT_RATIO = 0.05;
const NO_DATA_ALERT_MIN_BATCH = 100;

/**
 * 日线。可回补（新浪 scale=240 一次 1023 根，约到 2022-05），
 * 所以失败记的是 recoverable gap，夜间 job 会重来。
 * 注：新浪日线不复权，adj_factor 保留既有值（默认 1.0），
 * 复权因子计算属于 M0 之外（见 spec R1）。
 */
export async function collectDaily(
  db: Db, client: SourceClient, codes: string[], datalen: number
): Promise<{ written: number; failed: string[]; noData: string[] }> {
  const stmt = db.prepare(
    `INSERT OR REPLACE INTO kline_daily (code, date, o, h, l, c, vol, amount, adj_factor)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, COALESCE(
       (SELECT adj_factor FROM kline_daily WHERE code = ? AND date = ?), 1.0))`
  );
  let written = 0; const failed: string[] = []; const noData: string[] = [];

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
      if (e instanceof SourceNoData) {
        // 源上没有这条序列，不是缺口：记成缺口就永远回补不掉
        noData.push(code);
        continue;
      }
      failed.push(code);
      recordGap(db, today(), client.source, `kline_daily:${code}`, e.message, true);
    }
  }

  if (codes.length >= NO_DATA_ALERT_MIN_BATCH &&
      noData.length / codes.length > NO_DATA_ALERT_RATIO) {
    recordGap(
      db, today(), client.source, "kline_daily:no_data_spike",
      `${noData.length}/${codes.length} 只无 K 线序列，超过 ${NO_DATA_ALERT_RATIO * 100}% ——` +
      ` 大概率是限频而非真的没数据，不要当正常情况忽略`,
      true
    );
  }

  return { written, failed, noData };
}
