import type { Db } from "@/lib/db";
import type { SourceClient } from "@/lib/data/client";
import { fetchMarginMarket, fetchMarginStockByDate } from "@/lib/data/sources/eastmoney";
import { recordGap, resolveGap } from "@/lib/data/gap";
import { tradingDaysBetween } from "@/lib/data/calendar";

export interface CollectMarginOpts {
  /** 交易日区间，含两端 */
  from: string;
  to: string;
  /**
   * 只补本地还缺的日子（默认 true）。夜间增量用它：已经齐的日子不再重拉，
   * 否则每晚都把十天 × 9 页重打一遍。
   */
  onlyMissing?: boolean;
  onDay?: (date: string, rows: number) => void;
}

export interface CollectMarginResult {
  marketRows: number;
  stockDays: number;
  stockRows: number;
  /** 交易日但源里还没有（未发布 / 限流）的日子 */
  missing: string[];
}

/**
 * 两融采集：先拉全市场汇总（一次请求覆盖整个区间），再按日拉个股明细。
 *
 * **全市场汇总是"这天有没有两融数据"的判据**：汇总里有这一天，个股明细却是 0 条，
 * 才是真缺口；汇总里也没有，多半是还没发布（T+1 开盘前才出），同样记可回补的缺口，
 * 下一晚会重来。两种情形都不能静默跳过 —— 静默的空会让"融资撤离"判据以为
 * 这只票没人借钱。
 *
 * 个股明细按日**整日原子写入**：一天的 9 页全部取回才落库，
 * 半天的数据会让"只有一半标的有两融"看起来像真的。
 */
export async function collectMargin(
  db: Db, client: SourceClient, o: CollectMarginOpts
): Promise<CollectMarginResult> {
  const days = tradingDaysBetween(db, o.from, o.to);
  const missing: string[] = [];
  if (days.length === 0) return { marketRows: 0, stockDays: 0, stockRows: 0, missing };

  let market;
  try {
    market = await fetchMarginMarket(client, days[0], days[days.length - 1]);
  } catch (e) {
    const msg = (e as Error).message;
    for (const d of days) recordGap(db, d, client.source, "margin", `两融汇总拉取失败：${msg}`, true);
    return { marketRows: 0, stockDays: 0, stockRows: 0, missing: days };
  }
  const insM = db.prepare(
    `INSERT OR REPLACE INTO margin_market
       (date, rzye, rqye, rzrqye, rzmre, rzche, rzjme, rzyezb, ltsz)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  db.transaction(() => {
    for (const r of market) insM.run(r.date, r.rzye, r.rqye, r.rzrqye, r.rzmre, r.rzche, r.rzjme, r.rzyezb, r.ltsz);
  })();
  const published = new Set(market.map(r => r.date));

  const have = db.prepare("SELECT COUNT(*) AS n FROM margin_stock WHERE date = ?");
  const insS = db.prepare(
    `INSERT OR REPLACE INTO margin_stock
       (date, code, rzye, rzmre, rzche, rzjme, rqye, rqyl, rzrqye, rzyezb)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );

  let stockDays = 0, stockRows = 0;
  for (const d of days) {
    if ((o.onlyMissing ?? true) && Number((have.get(d) as any).n) > 0) continue;
    if (!published.has(d)) {
      missing.push(d);
      recordGap(db, d, client.source, "margin", `两融 ${d} 尚未发布（T+1 开盘前才出）`, true);
      continue;
    }
    try {
      const rows = await fetchMarginStockByDate(client, d);
      if (rows.length === 0) {
        missing.push(d);
        recordGap(db, d, client.source, "margin", `两融汇总有 ${d}，个股明细却是 0 条`, true);
        continue;
      }
      db.transaction(() => {
        db.prepare("DELETE FROM margin_stock WHERE date = ?").run(d);
        for (const r of rows) {
          insS.run(r.date, r.code, r.rzye, r.rzmre, r.rzche, r.rzjme, r.rqye, r.rqyl, r.rzrqye, r.rzyezb);
        }
      })();
      resolveGap(db, d, client.source, "margin");
      stockDays++;
      stockRows += rows.length;
      o.onDay?.(d, rows.length);
    } catch (e) {
      const msg = (e as Error).message;
      missing.push(d);
      recordGap(db, d, client.source, "margin", `两融个股 ${d} 拉取失败：${msg}`, true);
      // 熔断打开后继续只会给剩下每一天各记一条同因的缺口
      if (/circuit open/.test(msg)) {
        const i = days.indexOf(d);
        for (const rest of days.slice(i + 1)) {
          missing.push(rest);
          recordGap(db, rest, client.source, "margin", `东财熔断，两融个股 ${rest} 本轮未拉`, true);
        }
        break;
      }
    }
  }
  return { marketRows: market.length, stockDays, stockRows, missing };
}
