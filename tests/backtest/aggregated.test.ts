import { describe, it, expect } from "vitest";
import {
  runWalkForwardAggregated, stitchEquity, suggestAggregatedPlan,
} from "@/lib/backtest/walkforward";
import { MIN_SAMPLE_DAYS, computeMetrics } from "@/lib/backtest/metrics";
import type { EquityPoint } from "@/lib/contracts";

/** 生成 n 个连续交易日（日历日近似，测试只关心顺序与数量） */
const mkDays = (n: number) =>
  Array.from({ length: n }, (_, i) =>
    new Date(Date.UTC(2023, 0, 1 + i)).toISOString().slice(0, 10));

/** 固定日收益的净值段，起点自定 —— 用来验证拼接不受各段基准影响 */
function seg(days: string[], dailyRet: number, base = 1): EquityPoint[] {
  let e = base;
  return days.map((d, i) => {
    if (i > 0) e *= 1 + dailyRet;
    return { date: d, equity: e, position: 0.5 };
  });
}

describe("stitchEquity", () => {
  it("按链式收益拼接，不受各段起点基准影响", () => {
    const d = mkDays(6);
    // 两段都是每日 +1%，但基准一个 1、一个 100
    const a = seg(d.slice(0, 3), 0.01, 1);
    const b = seg(d.slice(3), 0.01, 100);
    const out = stitchEquity([a, b]);
    // 拼接后应当是连续的 +1% 复利，段边界不该出现跳空
    for (let i = 1; i < out.length; i++) {
      expect(out[i].equity / out[i - 1].equity).toBeCloseTo(1.01, 10);
    }
  });

  it("直接首尾相接会造出假跳空，链式拼接不会", () => {
    const d = mkDays(6);
    const a = seg(d.slice(0, 3), 0, 1);      // 平的
    const b = seg(d.slice(3), 0, 100);       // 也是平的，但基准 100
    const out = stitchEquity([a, b]);
    // 全程平，最大回撤必须是 0；若按净值直接相接会出现 1 → 100 的假暴涨
    const eq = out.map(p => p.equity);
    expect(Math.max(...eq) / Math.min(...eq)).toBeCloseTo(1, 10);
  });

  it("段起点非正时跳过该段，不产出 NaN/Infinity", () => {
    const d = mkDays(4);
    const bad: EquityPoint[] = d.slice(0, 2).map(x => ({ date: x, equity: 0, position: 0 }));
    const good = seg(d.slice(2), 0.01, 1);
    const out = stitchEquity([bad, good]);
    expect(out.every(p => Number.isFinite(p.equity))).toBe(true);
  });
});

describe("suggestAggregatedPlan", () => {
  it("R1 的 630 天区间能切出够用的聚合样本外", () => {
    const plan = suggestAggregatedPlan(630);
    expect(plan).not.toBeNull();
    // 训练 252 / 测试 63 → 6 段，每段拼接后贡献 62 个点 = 372 天 > 252，非退化
    expect(plan!.segments).toBe(6);
    expect(plan!.oosDays).toBe(372);
    expect(plan!.oosDays).toBeGreaterThanOrEqual(MIN_SAMPLE_DAYS);
  });

  it("单次 7:3 在同一区间只给 189 天 —— 这就是它测不出结论的原因", () => {
    const single = Math.round(630 * 0.3);
    expect(single).toBeLessThan(MIN_SAMPLE_DAYS);
    expect(suggestAggregatedPlan(630)!.oosDays).toBeGreaterThan(single);
  });

  it("区间确实不够时返回 null，而不是硬凑一个方案", () => {
    // 300 天：训练 252 后只剩 48 天，无论怎么切聚合样本外都不够
    expect(suggestAggregatedPlan(300)).toBeNull();
  });
});

describe("runWalkForwardAggregated", () => {
  const days = mkDays(630);
  const plan = suggestAggregatedPlan(630)!;

  function run(dailyRet: number, tradesPerSeg = 10) {
    return runWalkForwardAggregated(days, {
      windowDays: plan.windowDays,
      stepDays: plan.stepDays,
      inSampleRatio: plan.windowDays === 315 ? 252 / 315 : 0.7,
      optimize: () => ({ params: { x: 1 } }),
      evaluate: (_p, _t, testDays) => {
        const equity = seg(testDays, dailyRet, 1);
        const closed = Array.from({ length: tradesPerSeg }, (_, i) => ({
          code: "601012", qty: 100, entryPx: 10, exitPx: dailyRet >= 0 ? 11 : 9,
          pnl: dailyRet >= 0 ? 100 : -100,
          entryDate: testDays[0], exitDate: testDays[testDays.length - 1],
        })) as any;
        return { metrics: computeMetrics({ equity, closed }), equity, closed };
      },
    });
  }

  it("plan 承诺的 oosDays 与拼接曲线的真实长度一致", () => {
    // 差一点都不行：落在 252 边缘时"承诺够、实际退化"会被误读成策略不行
    const r = run(0.001);
    expect(r.oosDays).toBe(plan.oosDays);
  });

  it("聚合样本外超过一年，Calmar 不再被判退化", () => {
    const r = run(0.001);
    expect(r.segments).toBe(plan.segments);
    expect(r.oosDays).toBeGreaterThanOrEqual(MIN_SAMPLE_DAYS);
    // 单窗口 63 天必然退化（各段 Calmar 为 0），聚合后才有非退化结论
    expect(r.segmentCalmars.every(c => c === 0)).toBe(true);
    expect(r.degeneracy.filter(d => /交易日/.test(d))).toHaveLength(0);
  });

  it("聚合曲线连续，段边界无跳空", () => {
    const r = run(0.001);
    for (let i = 1; i < r.equity.length; i++) {
      expect(r.equity[i].equity / r.equity[i - 1].equity).toBeCloseTo(1.001, 8);
    }
  });

  it("亏损策略聚合后仍然是亏的 —— 拼接不会把负收益变正", () => {
    const r = run(-0.001);
    expect(r.equity[r.equity.length - 1].equity).toBeLessThan(1);
  });

  it("每段用的参数只来自该段之前的训练区间", () => {
    const seenTrainEnds: string[] = [];
    const seenTestStarts: string[] = [];
    runWalkForwardAggregated(days, {
      windowDays: plan.windowDays, stepDays: plan.stepDays, inSampleRatio: 252 / 315,
      optimize: (train) => { seenTrainEnds.push(train.to); return { params: {} }; },
      evaluate: (_p, test, testDays) => {
        seenTestStarts.push(test.from);
        const equity = seg(testDays, 0.001, 1);
        return { metrics: computeMetrics({ equity, closed: [] }), equity, closed: [] };
      },
    });
    // 训练段结束日必须严格早于对应测试段起始日，否则就是用未来数据调参
    for (let i = 0; i < seenTrainEnds.length; i++) {
      expect(seenTrainEnds[i] < seenTestStarts[i]).toBe(true);
    }
  });
});
