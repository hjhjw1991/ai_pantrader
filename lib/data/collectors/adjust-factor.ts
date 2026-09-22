import type { Db } from "@/lib/db";
import type { SourceClient } from "@/lib/data/client";
import {
  AdjustUnsupported, SourceNoAdjust, fetchAdjustFactors, type AdjustFactor,
} from "@/lib/data/sources/sina-adjust";
import { recordGap, resolveGap, resolveGapsForKind, today } from "@/lib/data/gap";

export interface AdjustResult {
  /** 成功回填的票数 */
  updated: number;
  /** 确认没有除权记录的票。因子 1.0 就是正确答案，**不是失败** */
  noAdjust: string[];
  /**
   * 这个源不覆盖的票（实测全是北交所）。因子留在 1.0，但那**不等于**没有分红 ——
   * 只是查不到。与 noAdjust 分开统计，因为两者的可信度完全不同。
   */
  unsupported: string[];
  failed: Array<{ code: string; error: string }>;
}

export interface CollectAdjustOpts {
  /** 记缺口用的日期。默认今天 */
  date?: string;
  /** 每只票之间的间隔，给源留点余地 */
  pauseMs?: number;
  onProgress?: (done: number, total: number) => void;
}

/**
 * 回填 kline_daily.adj_factor。
 *
 * 这一列**从建库起就存在**，只是一直是默认值 1.0 —— 也就是说库里所有"复权价"
 * 其实都是原始价。日线窗口短的时候这个错误不显眼，但周线月线跨年，
 * 一次 10 送 10 就能在 MACD 上造出一个不存在的死叉。
 *
 * 按**区间**写而不是逐根写：因子表一只票通常只有几十条，
 * 每条对应一个 [生效日, 下一个生效日) 的区间，一条 UPDATE 刷一片。
 * 逐根写要先把日期全读出来，5888 只票 × 上千根 = 几百万次往返。
 *
 * 失败时**一行都不改**：改一半会让序列在中间断层，而断层处的涨跌幅是凭空造出来的，
 * 比整段没复权更难发现 —— 后者至少是一致的错，前者是随机的错。
 */
export async function collectAdjustFactors(
  db: Db, client: SourceClient, codes: string[], o: CollectAdjustOpts = {}
): Promise<AdjustResult> {
  const date = o.date ?? today();
  const pauseMs = o.pauseMs ?? 0;

  const seg = db.prepare(
    `UPDATE kline_daily SET adj_factor = ?
      WHERE code = ? AND date >= ? AND date < ?`
  );
  const tail = db.prepare(
    `UPDATE kline_daily SET adj_factor = ?
      WHERE code = ? AND date >= ?`
  );

  let updated = 0;
  const noAdjust: string[] = [];
  const unsupported: string[] = [];
  const failed: AdjustResult["failed"] = [];

  let done = 0;
  for (const code of codes) {
    try {
      const rows = await fetchAdjustFactors(client, code);
      writeFactors(db, code, rows, seg, tail);
      updated++;
      /**
       * 跨**所有日期**销账，不是只销今天。
       *
       * 复权因子与日线同类：一次成功把该票**整段历史**的因子重写一遍
       * （collectors/daily.ts 里记着同一条理由）。只销今天的话，
       * 上周那次失败留下的缺口会永远挂着 —— 而回测的 hasGap(date) 不带 kind，
       * 那一天会对全市场直接跳过。
       */
      resolveGapsForKind(db, client.source, `adj_factor:${code}`);
    } catch (e) {
      if (e instanceof SourceNoAdjust) {
        /**
         * 没有除权记录 = 不需要复权，因子保持 1.0 就是正确答案。
         * 记成缺口会让 data_gap 永远挂着一批回补不掉的条目，把真事故淹掉
         * （sina.ts 的 SourceNoData 踩过同一个坑：实测 14 只票长期返回 null）。
         */
        noAdjust.push(code);
        resolveGapsForKind(db, client.source, `adj_factor:${code}`);
      } else if (e instanceof AdjustUnsupported) {
        /**
         * 逐只记缺口会留下永远补不掉的记录，
         * 而 selfcheck 的未解决缺口数是给人看"今天有没有出事"的 —— 常驻噪音会把真事故淹掉。
         * 所以这里只归类，聚合成一条在循环外记。
         */
        unsupported.push(code);
        // 逐只的缺口已经被聚合成一条，旧的那些无论记在哪天都该销掉
        resolveGapsForKind(db, client.source, `adj_factor:${code}`);
      } else {
        const msg = (e as Error).message;
        recordGap(db, date, client.source, `adj_factor:${code}`, msg, true);
        failed.push({ code, error: msg });
      }
    }
    done++;
    o.onProgress?.(done, codes.length);
    if (pauseMs > 0) await new Promise(r => setTimeout(r, pauseMs));
  }

  /**
   * 一条聚合缺口，**不可回补**。
   *
   * 不可回补是实话：新浪就是不提供这些票的 hfq.js，重试一万次也一样。
   * 但它必须留在缺口表里 —— 那些票的复权价现在是错的（因子 1.0），
   * 只是我们无从修正。把它抹掉等于宣称"复权数据完整"，那是假的。
   */
  if (unsupported.length > 0) {
    recordGap(
      db, date, client.source, "adj_factor:unsupported",
      `${unsupported.length} 只标的该源不提供复权因子（实测均为北交所），` +
      `其复权价按因子 1.0 处理 —— 有分红的票会因此偏差，技术指标须知情`,
      false
    );
  } else {
    resolveGap(db, date, client.source, "adj_factor:unsupported");
  }

  return { updated, noAdjust, unsupported, failed };
}

/** 一只票的因子区间写入，整体一个事务：要么全写要么不写 */
function writeFactors(
  db: Db, code: string, rows: AdjustFactor[], seg: any, tail: any
): void {
  db.transaction(() => {
    for (let i = 0; i < rows.length; i++) {
      const { date: from, factor } = rows[i];
      const next = i + 1 < rows.length ? rows[i + 1].date : null;
      if (next === null) tail.run(factor, code, from);
      else seg.run(factor, code, from, next);
    }
  })();
}
