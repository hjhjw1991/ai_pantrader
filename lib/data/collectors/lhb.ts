import type { Db } from "@/lib/db";
import type { SourceClient } from "@/lib/data/client";
import { fetchLhb, fetchLhbSeats } from "@/lib/data/sources/eastmoney";
import { recordGap, resolveGap } from "@/lib/data/gap";

export interface LhbCollectResult {
  fetched: number;
  stored: number;
  seatsFetched: number;
  seatsStored: number;
}

/**
 * 龙虎榜。实测可按历史日期回补，且自带 D1..D30 后续涨跌幅（天然监督标签），
 * 所以失败记 recoverable gap 交给回补流程。
 *
 * 落库后断言 stored === fetched。这条是硬要求：
 * 主键设计错误曾让 58 行静默存成 30 行、job 还报成功，只有行数断言能抓住这类事故。
 */
export async function collectLhb(
  db: Db, client: SourceClient, date: string
): Promise<LhbCollectResult> {
  let rows, buySeats, sellSeats;
  try {
    rows = await fetchLhb(client, date);
    buySeats = await fetchLhbSeats(client, date, "buy");
    sellSeats = await fetchLhbSeats(client, date, "sell");
  } catch (e: any) {
    recordGap(db, date, client.source, "lhb", e.message, true);
    throw e;
  }

  const stmt = db.prepare(
    `INSERT OR REPLACE INTO lhb
     (date, code, change_type, trade_id, name, explanation, explain_stat,
      net_amt, buy_amt, sell_amt, billboard_deal_amt, deal_amount_ratio, deal_net_ratio,
      buy_seat_raw, sell_seat_raw, buy_ratio, sell_ratio,
      close_price, change_rate, turnover_rate, accum_amount, free_market_cap, trade_market,
      d1_chg, d2_chg, d5_chg, d10_chg, d20_chg, d30_chg)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );

  // 席位表无业务主键（机构专用共用 dept_code='0'），幂等靠按 (date, side) 先删后插
  const delSeats = db.prepare(`DELETE FROM lhb_seat WHERE date = ? AND side = ?`);
  const seatStmt = db.prepare(
    `INSERT INTO lhb_seat
     (date, code, change_type, side, dept_code, dept_name,
      buy_amt, sell_amt, net_amt, buy_ratio, sell_ratio, rise_prob_3d, buyer_times_3d)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );

  const seats = [...buySeats, ...sellSeats];

  db.transaction(() => {
    for (const r of rows) {
      stmt.run(
        r.date, r.code, r.changeType, r.tradeId, r.name, r.explanation, r.explainStat,
        r.netAmt, r.buyAmt, r.sellAmt, r.billboardDealAmt, r.dealAmountRatio, r.dealNetRatio,
        r.buySeatRaw, r.sellSeatRaw, r.buyRatio, r.sellRatio,
        r.closePrice, r.changeRate, r.turnoverRate, r.accumAmount, r.freeMarketCap, r.tradeMarket,
        r.d1Chg, r.d2Chg, r.d5Chg, r.d10Chg, r.d20Chg, r.d30Chg
      );
    }
    for (const side of ["buy", "sell"] as const) delSeats.run(date, side);
    for (const s of seats) {
      seatStmt.run(
        s.date, s.code, s.changeType, s.side, s.deptCode, s.deptName,
        s.buyAmt, s.sellAmt, s.netAmt, s.buyRatio, s.sellRatio, s.riseProb3d, s.buyerTimes3d
      );
    }
  })();

  const stored = (db.prepare(`SELECT COUNT(*) n FROM lhb WHERE date = ?`)
    .get(date) as { n: number }).n;
  const seatsStored = (db.prepare(`SELECT COUNT(*) n FROM lhb_seat WHERE date = ?`)
    .get(date) as { n: number }).n;

  if (stored !== rows.length) {
    const msg = `lhb row loss on ${date}: fetched ${rows.length} but stored ${stored}` +
      ` —— 主键折叠了不同的上榜记录，改主键前别动这条断言`;
    recordGap(db, date, client.source, "lhb", msg, true);
    throw new Error(msg);
  }
  if (seatsStored !== seats.length) {
    const msg = `lhb_seat row loss on ${date}: fetched ${seats.length} but stored ${seatsStored}`;
    recordGap(db, date, client.source, "lhb", msg, true);
    throw new Error(msg);
  }

  resolveGap(db, date, client.source, "lhb");
  return { fetched: rows.length, stored, seatsFetched: seats.length, seatsStored };
}
