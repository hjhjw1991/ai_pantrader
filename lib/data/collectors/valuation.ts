import type { Db } from "@/lib/db";
import type { SourceClient } from "@/lib/data/client";
import { fetchValuations } from "@/lib/data/sources/eastmoney";
import { recordGap, resolveGap, today } from "@/lib/data/gap";

export interface ValuationResult {
  written: number;
  /** 拿到但因为全为空而跳过的行数（退市 / PT / 长期停牌） */
  skipped: number;
}

export interface CollectValuationOpts {
  date?: string;
  pageSize?: number;
  onPage?: (pn: number, got: number, total: number) => void;
  /**
   * 主机轮换参数，透传给 fetchValuations。
   * 默认值（10 个主机 × 多轮退避）对夜间任务是对的，但会让"注定失败"的一轮拖很久 ——
   * 测试与盘中手动触发需要快速失败。
   */
  rounds?: number;
  backoffMs?: number;
  retries?: number;
}

/**
 * 全市场估值快照。
 *
 * **不可回补**：东财只给此刻的 PE/PB，没有历史接口。所以这张表从接入那天起往前攒，
 * 之前一片空白且永远补不回来 —— 与涨停池同属"当日现场"。
 * 失败因此记 recoverable=false 的缺口：明天重来拿到的是明天的数，不是今天的。
 *
 * 好在你要的"PE 市场分位对比平均"是**横截面**分位（今天这只票 vs 今天全市场），
 * 一天的快照就能算。只有"这只票 vs 它自己过去 N 年"的时序分位才需要攒够历史。
 *
 * 分位本身不入库：它依赖全市场横截面，存进来等于把口径焊死（按全市场还是按行业？
 * 剔不剔亏损股？）。因子层拿当日数据现算，换口径不必重灌。
 */
export async function collectValuation(
  db: Db, client: SourceClient, o: CollectValuationOpts = {}
): Promise<ValuationResult> {
  const date = o.date ?? today();

  let rows;
  try {
    rows = await fetchValuations(client, {
      pageSize: o.pageSize, onPage: o.onPage,
      rounds: o.rounds, backoffMs: o.backoffMs, retries: o.retries,
    });
  } catch (e) {
    const msg = (e as Error).message;
    recordGap(db, date, client.source, "valuation", `估值快照失败：${msg}`, false);
    return { written: 0, skipped: 0 };
  }

  const stmt = db.prepare(
    `INSERT OR REPLACE INTO valuation_daily (code, date, pe, pb, mktcap, float_mktcap)
     VALUES (?, ?, ?, ?, ?, ?)`
  );

  let written = 0, skipped = 0;
  db.transaction(() => {
    for (const r of rows) {
      /**
       * 四个字段全空就不写。
       *
       * 退市股、PT 股、长期停牌票在东财那边全是 "-"，写一行全 null 既占地方
       * 又让"有行=有数据"这个直觉失效。**但负 PE 要写** —— 那是亏损，
       * 是真实读数，过滤掉等于把亏损伪装成没数据。
       */
      if (r.pe === null && r.pb === null && r.mktcap === null && r.floatMktcap === null) {
        skipped++;
        continue;
      }
      stmt.run(r.code, date, r.pe, r.pb, r.mktcap, r.floatMktcap);
      written++;
    }
  })();

  if (written === 0) {
    // 空响应体是限流的典型表现，不是"今天全市场都没有估值"
    recordGap(
      db, date, client.source, "valuation",
      `估值快照 0 条写入（取回 ${rows.length} 行，全部为空）—— 多半是限流`, false
    );
  } else {
    resolveGap(db, date, client.source, "valuation");
  }

  return { written, skipped };
}
