import { describe, expect, it } from "vitest";
import type { EquityPoint } from "@/lib/contracts";
import {
  MIN_SAMPLE_DAYS, MIN_SAMPLE_TRADES, TRADING_DAYS_PER_YEAR,
  computeMetrics, computeMetricsDetailed, maxDrawdown,
} from "@/lib/backtest/metrics";
import type { ClosedTrade } from "@/lib/backtest/types";

function eqSeries(values: number[], from = 0): EquityPoint[] {
  return values.map((v, i) => ({ date: `d${String(from + i).padStart(4, "0")}`, equity: v, position: 0 }));
}

/** 造 n 笔往返，前 win 笔赚 pnl+，其余亏 pnl- */
function closedTrades(n: number, win: number, gain = 1000, loss = -500): ClosedTrade[] {
  return Array.from({ length: n }, (_, i) => ({
    code: `60000${i % 10}`, account: "卫星" as const,
    entryDate: "2026-01-05", exitDate: "2026-01-09",
    entryPx: 10, exitPx: i < win ? 11 : 9.5, qty: 1000,
    pnl: i < win ? gain : loss, fees: 10, holdDays: i < win ? 4 : 2,
  }));
}

/** 两年、日涨 0.1%、中间连亏 10 天 −1% 的净值曲线 */
function twoYearCurve(): EquityPoint[] {
  const eq = [100];
  for (let i = 1; i <= 504; i++) eq.push(eq[i - 1] * (i >= 200 && i < 210 ? 0.99 : 1.001));
  return eqSeries(eq);
}

describe("最大回撤", () => {
  it("按历史峰值算，返回正的比例", () => {
    expect(maxDrawdown([100, 110, 99].map((v, i) => ({ date: `d${i}`, equity: v, position: 0 })))).toBeCloseTo(0.1, 10);
    expect(maxDrawdown(eqSeries([100, 90, 120, 60]))).toBeCloseTo(0.5, 10);
    expect(maxDrawdown(eqSeries([100, 101, 102]))).toBe(0);
  });
});

describe("样本充足时的正常口径", () => {
  const metrics = computeMetrics({ equity: twoYearCurve(), closed: closedTrades(40, 24) });

  it("年化按 252 交易日折算", () => {
    expect(TRADING_DAYS_PER_YEAR).toBe(252);
    expect(metrics.annualReturn).toBeCloseTo(0.21728735, 6);
  });

  it("最大回撤 = 连亏 10 天的 0.99^10", () => {
    expect(metrics.maxDrawdown).toBeCloseTo(1 - Math.pow(0.99, 10), 8);
  });

  it("Calmar = 年化 / 最大回撤（优化目标，spec §10.4）", () => {
    expect(metrics.calmar).toBeCloseTo(2.27245419, 6);
    expect(metrics.calmar).toBeCloseTo(metrics.annualReturn / metrics.maxDrawdown, 10);
  });

  it("胜率与盈亏比来自往返交易", () => {
    expect(metrics.trades).toBe(40);
    expect(metrics.winRate).toBeCloseTo(24 / 40, 10);
    // 24 笔 × 1000 赚 / 16 笔 × 500 亏
    expect(metrics.profitFactor).toBeCloseTo(24000 / 8000, 10);
    expect(metrics.avgHoldDays).toBeCloseTo((24 * 4 + 16 * 2) / 40, 10);
  });
});

describe("Sharpe", () => {
  it("日收益均值/样本标准差 × sqrt(252)", () => {
    const eq = eqSeries([100, 102, 100.98, 104.0094]); // +2%, −1%, +3%
    const m = computeMetrics({ equity: eq, closed: [] });
    expect(m.sharpe).toBeCloseTo(10.16782255, 6);
  });

  it("波动为 0 时返回 0，不返回 Infinity", () => {
    const eq = eqSeries([100, 101, 102.01, 103.0301]);
    expect(computeMetrics({ equity: eq, closed: [] }).sharpe).toBe(0);
  });
});

describe("退化情形不许伪装成好分数", () => {
  it("零回撤 → Calmar 记 0（不是 Infinity）", () => {
    const eq = eqSeries(Array.from({ length: 505 }, (_, i) => 100 * Math.pow(1.001, i)));
    const d = computeMetricsDetailed({ equity: eq, closed: closedTrades(40, 40) });
    expect(d.metrics.maxDrawdown).toBe(0);
    expect(d.metrics.calmar).toBe(0);
    expect(Number.isFinite(d.metrics.calmar)).toBe(true);
    expect(d.degeneracy).toContain("零回撤");
    // 原始值仍然报出来给人看，只是不进优化目标
    expect(d.rawCalmar).toBe(null);
  });

  it("样本区间不足一年 → Calmar 记 0", () => {
    // 60 个交易日涨到 112，末日回落到 105：有回撤、有正收益，但区间只有 3 个月
    const eq = eqSeries([...Array(60).keys()].map((i) => 100 * Math.pow(1.002, i)).concat([105]));
    const d = computeMetricsDetailed({ equity: eq, closed: closedTrades(40, 30) });
    expect(d.metrics.calmar).toBe(0);
    expect(d.degeneracy.some((x) => x.includes("不足"))).toBe(true);
    expect(d.metrics.annualReturn).not.toBe(0); // 原始统计照算
  });

  it("交易笔数不够统计意义 → Calmar 记 0", () => {
    const d = computeMetricsDetailed({ equity: twoYearCurve(), closed: closedTrades(MIN_SAMPLE_TRADES - 1, 20) });
    expect(d.metrics.calmar).toBe(0);
    expect(d.degeneracy.some((x) => x.includes("笔数"))).toBe(true);
    expect(d.rawCalmar).toBeCloseTo(2.27245419, 6); // 原始 Calmar 仍报出
  });

  it("样本足够时不标退化", () => {
    const d = computeMetricsDetailed({ equity: twoYearCurve(), closed: closedTrades(MIN_SAMPLE_TRADES, 20) });
    expect(d.degeneracy).toEqual([]);
    expect(d.metrics.calmar).toBeGreaterThan(0);
  });

  it("空净值曲线全 0，不抛错", () => {
    const m = computeMetrics({ equity: [], closed: [] });
    expect(m).toMatchObject({ calmar: 0, annualReturn: 0, maxDrawdown: 0, sharpe: 0, trades: 0 });
  });

  it("全亏光（净值到 0）不产生 NaN", () => {
    const eq = eqSeries([100, 50, 0, 0]);
    const m = computeMetrics({ equity: eq, closed: closedTrades(40, 0) });
    expect(Number.isFinite(m.annualReturn)).toBe(true);
    expect(m.maxDrawdown).toBe(1);
    expect(m.calmar).toBeLessThanOrEqual(0);
  });

  it("没有亏损单时盈亏比记 0，不返回 Infinity", () => {
    const m = computeMetrics({ equity: twoYearCurve(), closed: closedTrades(40, 40) });
    expect(m.profitFactor).toBe(0);
  });

  it("门槛是常量、可被寻优与报告引用", () => {
    expect(MIN_SAMPLE_TRADES).toBe(30);
    expect(MIN_SAMPLE_DAYS).toBe(252);
  });
});
