import { describe, expect, it } from "vitest";
import { DEFAULT_CONSTRAINTS } from "@/lib/contracts";
import {
  DEFAULT_FILL_OPTIONS, evaluateFill, isLimitDownBar, isLimitUpBar,
  limitBand, limitDownPx, limitUpFillProb, limitUpPx, roundFee, sellableQty,
} from "@/lib/backtest/constraints";
import type { MarketState } from "@/lib/backtest/types";
import { makeBar } from "./helpers/fixtures";

/** 一个正常可成交的市场状态：主板、非 ST、有日线、昨收 10 元 */
function normalMarket(over: Partial<MarketState> = {}): MarketState {
  return {
    date: "2026-03-02", code: "600000", board: "主板", isSt: false,
    listDate: "2015-01-01", prevClose: 10,
    bar: makeBar("600000", "2026-03-02", 10.1, 10.5, 9.9, 10.3),
    zt: null, dt: null,
    ...over,
  };
}

describe("涨跌幅带 (spec §8.1)", () => {
  it("按板块与 ST 状态给出正确的带宽", () => {
    expect(limitBand("主板", false)).toBe(0.1);
    expect(limitBand("创业板", false)).toBe(0.2);
    expect(limitBand("科创板", false)).toBe(0.2);
    expect(limitBand("北交所", false)).toBe(0.3);
    expect(limitBand("主板", true)).toBe(0.05);
    expect(limitBand("创业板", true)).toBe(0.05);
    // 北交所 ST 不降到 5%，仍是 30%
    expect(limitBand("北交所", true)).toBe(0.3);
  });

  it("涨跌停价四舍五入到分", () => {
    expect(limitUpPx(10, "主板", false)).toBe(11);
    expect(limitDownPx(10, "主板", false)).toBe(9);
    expect(limitUpPx(13.33, "主板", false)).toBe(14.66); // 13.33*1.1 = 14.663
    expect(limitUpPx(10, "主板", true)).toBe(10.5);
    expect(limitUpPx(10, "创业板", false)).toBe(12);
  });

  it("代理判涨停：pct 达阈值且 close==high", () => {
    const up = makeBar("600000", "2026-03-02", 10.5, 11, 10.4, 11);
    expect(isLimitUpBar(up, 10, "主板", false, "2015-01-01")).toBe(true);
    // 涨到 10.9（+9%）不算
    const near = makeBar("600000", "2026-03-02", 10.5, 10.9, 10.4, 10.9);
    expect(isLimitUpBar(near, 10, "主板", false, "2015-01-01")).toBe(false);
    // 涨幅够但收盘不等于最高 —— 炸板，不算封板
    const opened = makeBar("600000", "2026-03-02", 10.5, 11, 10.4, 10.95);
    expect(isLimitUpBar(opened, 10, "主板", false, "2015-01-01")).toBe(false);
    // 上市首日无涨跌幅限制，一律不判涨停
    expect(isLimitUpBar(up, 10, "主板", false, "2026-03-02")).toBe(false);
  });

  it("代理判跌停：pct 达阈值且 close==low", () => {
    const dn = makeBar("600000", "2026-03-02", 9.5, 9.6, 9, 9);
    expect(isLimitDownBar(dn, 10, "主板", false, "2015-01-01")).toBe(true);
    const notLow = makeBar("600000", "2026-03-02", 9.5, 9.6, 9, 9.05);
    expect(isLimitDownBar(notLow, 10, "主板", false, "2015-01-01")).toBe(false);
  });
});

describe("涨停封板成交概率", () => {
  const bar = makeBar("600000", "2026-03-02", 11, 11, 11, 11, 1_000_000, 100_000_000);

  it("没有封单额（历史代理重建）一律判 0 —— 保守优先", () => {
    // 涨停池不可回补，2026-08-03 之前的历史日期没有 seal_amt。
    // 这时候若给个乐观概率，回测会把买不进的板算成买进了，收益虚高。
    expect(limitUpFillProb(null, bar, DEFAULT_FILL_OPTIONS)).toBe(0);
  });

  it("封单越大概率越低，单调递减", () => {
    const p = (sealAmt: number, openTimes = 0) =>
      limitUpFillProb(
        { date: "2026-03-02", code: "600000", lbc: 1, sealAmt, openTimes, firstSealTs: null, lastSealTs: null, sector: null },
        bar, DEFAULT_FILL_OPTIONS
      );
    // 半概率点：封单额 = 成交额 * 10%
    expect(p(10_000_000)).toBeCloseTo(0.5, 6);
    expect(p(0)).toBeCloseTo(1, 6);
    expect(p(30_000_000)).toBeCloseTo(0.25, 6);
    expect(p(90_000_000)).toBeCloseTo(0.1, 6);
    expect(p(30_000_000)).toBeLessThan(p(10_000_000));
    expect(p(90_000_000)).toBeLessThan(p(30_000_000));
  });

  it("炸板过说明封单被砸开，概率抬到下限", () => {
    const huge = { date: "2026-03-02", code: "600000", lbc: 1, sealAmt: 900_000_000, openTimes: 2, firstSealTs: null, lastSealTs: null, sector: null };
    expect(limitUpFillProb(huge, bar, DEFAULT_FILL_OPTIONS)).toBeCloseTo(0.85, 6);
  });
});

describe("约束逐条阻断", () => {
  it("停牌：当日无日线 → 买卖都不成交", () => {
    const m = normalMarket({ bar: null });
    const buy = evaluateFill({ code: "600000", side: "buy", qty: 1000, limitPx: 10 }, m, DEFAULT_CONSTRAINTS);
    expect(buy.filled).toBe(false);
    expect(buy.blockedBy).toBe("停牌");
    const sell = evaluateFill({ code: "600000", side: "sell", qty: 1000, limitPx: 10 }, m, DEFAULT_CONSTRAINTS);
    expect(sell.blockedBy).toBe("停牌");
  });

  it("一字板：买入被封板阻断", () => {
    const m = normalMarket({
      bar: makeBar("600000", "2026-03-02", 11, 11, 11, 11, 1_000_000, 100_000_000),
      zt: { date: "2026-03-02", code: "600000", lbc: 1, sealAmt: 500_000_000, openTimes: 0, firstSealTs: null, lastSealTs: null, sector: null },
    });
    const r = evaluateFill({ code: "600000", side: "buy", qty: 1000, limitPx: 11 }, m, DEFAULT_CONSTRAINTS);
    expect(r.filled).toBe(false);
    expect(r.blockedBy).toBe("涨停封板");
    expect(r.fillProb).toBeLessThan(0.5);
  });

  it("封单小 → 部分成交，成交量按概率打折且取整到一手", () => {
    const m = normalMarket({
      bar: makeBar("600000", "2026-03-02", 11, 11, 11, 11, 1_000_000, 100_000_000),
      zt: { date: "2026-03-02", code: "600000", lbc: 1, sealAmt: 4_000_000, openTimes: 0, firstSealTs: null, lastSealTs: null, sector: null },
    });
    const r = evaluateFill({ code: "600000", side: "buy", qty: 1000, limitPx: 11 }, m, DEFAULT_CONSTRAINTS);
    expect(r.fillProb).toBeCloseTo(1 / 1.4, 6); // sealRatio=0.04, R=0.1 → 1/(1+0.4)
    expect(r.filled).toBe(true);
    expect(r.qty).toBe(700); // floor(1000*0.714/100)*100
  });

  it("涨停但盘中回落到触发价 → 可以成交，不该被封板规则误杀", () => {
    const m = normalMarket({
      // 收盘涨停 11，但最低到过 10.2
      bar: makeBar("600000", "2026-03-02", 10.5, 11, 10.2, 11, 1_000_000, 100_000_000),
      zt: { date: "2026-03-02", code: "600000", lbc: 1, sealAmt: 500_000_000, openTimes: 1, firstSealTs: null, lastSealTs: null, sector: null },
    });
    const r = evaluateFill({ code: "600000", side: "buy", qty: 1000, limitPx: 10.3 }, m, DEFAULT_CONSTRAINTS);
    expect(r.filled).toBe(true);
    expect(r.blockedBy).toBe(null);
  });

  it("跌停卖不出", () => {
    const m = normalMarket({
      bar: makeBar("600000", "2026-03-02", 9, 9, 9, 9, 1_000_000, 90_000_000),
      dt: { date: "2026-03-02", code: "600000", sealAmt: 400_000_000 },
    });
    const r = evaluateFill({ code: "600000", side: "sell", qty: 1000, limitPx: 9 }, m, DEFAULT_CONSTRAINTS);
    expect(r.filled).toBe(false);
    expect(r.blockedBy).toBe("跌停封板");
  });

  it("ST 5% 带：挂到 +8% 的价格交易所直接拒单", () => {
    const m = normalMarket({
      isSt: true,
      bar: makeBar("600000", "2026-03-02", 10.2, 10.5, 10.1, 10.5),
    });
    const r = evaluateFill({ code: "600000", side: "buy", qty: 1000, limitPx: 10.8 }, m, DEFAULT_CONSTRAINTS);
    expect(r.filled).toBe(false);
    expect(r.blockedBy).toBe("涨跌幅越界");
    // 同一笔在非 ST 主板票上是合法的（带宽 10%）
    const ok = evaluateFill({ code: "600000", side: "buy", qty: 1000, limitPx: 10.8 }, normalMarket(), DEFAULT_CONSTRAINTS);
    expect(ok.filled).toBe(true);
  });

  it("限价没被触及不成交", () => {
    const m = normalMarket(); // 最低 9.9
    const r = evaluateFill({ code: "600000", side: "buy", qty: 1000, limitPx: 9.5 }, m, DEFAULT_CONSTRAINTS);
    expect(r.filled).toBe(false);
    expect(r.blockedBy).toBe("未触及限价");
  });

  it("跳空低开时按开盘价成交，不按限价（成交价只会更有利）", () => {
    const m = normalMarket({ bar: makeBar("600000", "2026-03-02", 9.5, 9.8, 9.4, 9.7) });
    const r = evaluateFill({ code: "600000", side: "buy", qty: 1000, limitPx: 10 }, m, DEFAULT_CONSTRAINTS);
    expect(r.filled).toBe(true);
    expect(r.px).toBeCloseTo(9.5 * (1 + DEFAULT_CONSTRAINTS.slippage), 6);
  });
});

describe("滑点与双边费用", () => {
  it("买入加滑点、卖出减滑点", () => {
    const m = normalMarket();
    // 限价 10 低于开盘 10.1 且当日最低 9.9 触及 → 按限价成交
    const buy = evaluateFill({ code: "600000", side: "buy", qty: 1000, limitPx: 10 }, m, DEFAULT_CONSTRAINTS);
    expect(buy.px).toBeCloseTo(10 * 1.002, 6);
    const sell = evaluateFill({ code: "600000", side: "sell", qty: 1000, limitPx: 10.2 }, m, DEFAULT_CONSTRAINTS);
    expect(sell.px).toBeCloseTo(10.2 * 0.998, 6);
  });

  it("费用双边收，且有最低佣金", () => {
    expect(roundFee(100_000, DEFAULT_CONSTRAINTS)).toBeCloseTo(130, 6);
    expect(roundFee(1_000, DEFAULT_CONSTRAINTS)).toBe(5); // 1.3 < minFee
    const m = normalMarket();
    const buy = evaluateFill({ code: "600000", side: "buy", qty: 1000, limitPx: 10 }, m, DEFAULT_CONSTRAINTS);
    expect(buy.fee).toBeCloseTo(Math.max(5, 10 * 1.002 * 1000 * DEFAULT_CONSTRAINTS.feeRate), 6);
    const sell = evaluateFill({ code: "600000", side: "sell", qty: 1000, limitPx: 10.2 }, m, DEFAULT_CONSTRAINTS);
    expect(sell.fee).toBeGreaterThan(0);
  });

  it("关掉约束就会虚高：limitUpUnbuyable=false 时一字板也能买进", () => {
    const m = normalMarket({
      bar: makeBar("600000", "2026-03-02", 11, 11, 11, 11, 1_000_000, 100_000_000),
      zt: { date: "2026-03-02", code: "600000", lbc: 1, sealAmt: 500_000_000, openTimes: 0, firstSealTs: null, lastSealTs: null, sector: null },
    });
    const r = evaluateFill({ code: "600000", side: "buy", qty: 1000, limitPx: 11 }, m, { ...DEFAULT_CONSTRAINTS, limitUpUnbuyable: false });
    expect(r.filled).toBe(true);
    expect(r.qty).toBe(1000);
  });
});

describe("T+1", () => {
  it("当日买入当日不可卖", () => {
    expect(sellableQty({ qty: 1000, openDate: "2026-03-02" }, "2026-03-02", DEFAULT_CONSTRAINTS)).toBe(0);
    expect(sellableQty({ qty: 1000, openDate: "2026-03-02" }, "2026-03-03", DEFAULT_CONSTRAINTS)).toBe(1000);
  });

  it("t1=false 时不再拦（用来量化这条约束值多少收益）", () => {
    expect(sellableQty({ qty: 1000, openDate: "2026-03-02" }, "2026-03-02", { ...DEFAULT_CONSTRAINTS, t1: false })).toBe(1000);
  });
});
