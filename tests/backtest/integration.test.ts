import { describe, expect, it } from "vitest";
import type { BacktestMetrics, SignalCard, StrategyEngine, StrategyEngineInput } from "@/lib/contracts";
import { optimize } from "@/lib/backtest/optimizer";
import { runBacktest } from "@/lib/backtest/replay";
import { planWalkForward, runWalkForward, summarizeWalkForward, walkForwardVerdict } from "@/lib/backtest/walkforward";
import {
  fakeTradingDays, makeBar, makeCandidate, makeCard, makeConfig, makeSecurity, makeViewFactory,
} from "./helpers/fixtures";

/**
 * 端到端：重放 → 网格寻优（样本内）→ walk-forward 样本外评估 → 裁决。
 * 这是 M4「参数面板改完能一键回测再上线」的骨架，也是唯一能证明这些模块拼得起来的测试。
 *
 * 行情用确定性正弦叠加，不用随机数：一是可复现（spec §17 断言 4），
 * 二是能同时造出足够多的往返与真实回撤，让 metrics 不落进退化分支。
 *
 * 顺带说明：这套参数在这条合成行情上是**亏钱**的（T+1 + 次日开盘成交 + 滑点吃掉了
 * 短周期波动的全部利润）。这不是测试缺陷 —— 回测本来就该能得出"不行"的结论。
 */
const days = fakeTradingDays("2024-01-01", 900);
// 快波（4 日）造往返，慢波（97 日）造持仓期回撤 —— 两者都要有，否则 metrics 会判退化
const px = (i: number) => 10 + 0.8 * Math.sin((2 * Math.PI * i) / 4) + 0.4 * Math.sin((2 * Math.PI * i) / 97);
const bars = days.map((d, i) => {
  const c = px(i);
  return makeBar("600000", d, c * 0.998, c * 1.01, c * 0.99, c, 1_000_000, 1_000_000 * c);
});
const viewFactory = makeViewFactory({
  tradingDays: days, bars: { "600000": bars }, securities: [makeSecurity("600000")],
});

/** 低买高卖的参数化策略：跌破 buyBelow 买、涨过 sellAbove 清 */
function makeStrategy(buyBelow: number, sellAbove: number): StrategyEngine {
  return (input: StrategyEngineInput): SignalCard => {
    const last = input.view.dailyBars("600000", 1)[0];
    if (!last) return makeCard(input.view.asOf, []);
    if (input.positions.length > 0 && last.c > sellAbove) {
      return makeCard(input.view.asOf, [], [makeCandidate({ code: "600000", action: "清仓", size: 0 })]);
    }
    if (input.positions.length === 0 && last.c < buyBelow) {
      return makeCard(input.view.asOf, [makeCandidate({ code: "600000", size: 0.9 })]);
    }
    return makeCard(input.view.asOf, []);
  };
}

function evaluateOn(params: Record<string, unknown>, range: { from: string; to: string }): BacktestMetrics {
  return runBacktest({
    from: range.from, to: range.to,
    viewFactory,
    strategy: makeStrategy(Number(params.buyBelow), Number(params.sellAbove)),
    config: makeConfig(),
    initialCash: 500_000,
  }).report.metrics;
}

const GRID = { buyBelow: [9.6, 9.8, 10.0], sellAbove: [10.4, 10.6, 10.8] };

describe("单次回测跑得动、样本够、指标不退化", () => {
  const out = runBacktest({
    from: days[0], to: days[399],
    viewFactory,
    strategy: makeStrategy(9.8, 10.6),
    config: makeConfig(),
    initialCash: 500_000,
    generatedAt: "2026-08-03T22:00:00+08:00",
  });

  it("400 个交易日、几十笔往返，Calmar 不再被退化规则记 0", () => {
    expect(out.detail.replayedDays).toHaveLength(400);
    expect(out.report.metrics.trades).toBeGreaterThanOrEqual(30);
    expect(out.detail.degeneracy).toEqual([]);
    expect(out.report.metrics.calmar).not.toBe(0);
    expect(Number.isFinite(out.report.metrics.calmar)).toBe(true);
  });

  it("成交价永远不等于决策日收盘价（逐笔核对 look-ahead）", () => {
    const closeByDate = new Map(bars.map((b) => [b.date, b.c]));
    for (const t of out.detail.trades) {
      expect(t.filledOn > t.decidedOn).toBe(true);
      expect(t.px).not.toBe(closeByDate.get(t.decidedOn));
    }
  });

  it("覆盖率首页：2024 起的区间不被复权断层砍，且覆盖率满", () => {
    expect(out.report.coverage.coverage).toBe(1);
    expect(out.report.coverage.gapDays).toBe(0);
    expect(out.report.coverage.effectiveRange).toEqual({ from: days[0], to: days[399] });
  });
});

describe("样本内寻优 + 样本外验证（spec §10.4 全链）", () => {
  const splits = planWalkForward(days, { windowDays: 360 });

  const windows = runWalkForward(days, {
    windowDays: 360,
    optimize: (train) => {
      const r = optimize({ grid: GRID, evaluate: (p) => evaluateOn(p, train) });
      return { params: r.best.params, metrics: r.best.metrics };
    },
    evaluate: (params, test) => evaluateOn(params, test),
  });

  it("窗口切分是 252/108 的 7:3", () => {
    expect(splits[0].trainDays).toHaveLength(252);
    expect(splits[0].testDays).toHaveLength(108);
    expect(windows).toHaveLength(splits.length);
  });

  it("每个窗口的最优参数都落在网格内", () => {
    for (const w of windows) {
      expect(GRID.buyBelow).toContain(w.bestParams.buyBelow);
      expect(GRID.sellAbove).toContain(w.bestParams.sellAbove);
    }
  });

  it("寻优确实是取样本内 argmax：最优点不差于任意其他网格点", () => {
    const train = splits[0].train;
    const best = optimize({ grid: GRID, evaluate: (p) => evaluateOn(p, train) });
    for (const e of best.evaluations) {
      expect(best.best.calmar).toBeGreaterThanOrEqual(e.calmar);
    }
    // 敏感度数据齐备，可以画热力图判断峰陡不陡
    expect(best.sensitivity).toHaveLength(2);
    expect(best.sensitivity[0].points).toHaveLength(3);
  });

  it("样本外只有 108 天 → 全部退化为 0，裁决判「测不出」而不是「策略不行」", () => {
    // 这是真实约束，不是缺陷：Calmar 要非退化，样本外段本身就得 ≥252 交易日，
    // 7:3 意味着单窗口 ≥840 日；而 spec R1 的有效区间只有约 2.6 年（≈630 日）。
    expect(windows.every((w) => w.testMetrics.calmar === 0)).toBe(true);
    const v = walkForwardVerdict(windows, { minCalmar: 1 });
    expect(v.pass).toBe(false);
    expect(v.undecidable).toBe(true);
    expect(v.reasons.join(" ")).toContain("测不出");
  });

  it("样本外拉到 252 天（单窗口 840 日）才测得出真结论", () => {
    const long = runWalkForward(days, {
      windowDays: 840,
      optimize: (train) => ({
        params: optimize({ grid: GRID, evaluate: (p) => evaluateOn(p, train) }).best.params,
      }),
      evaluate: (params, test) => evaluateOn(params, test),
    });
    expect(long).toHaveLength(1);
    const w = long[0];
    expect(w.testMetrics.trades).toBeGreaterThanOrEqual(30);
    expect(w.testMetrics.calmar).not.toBe(0);
    const v = walkForwardVerdict(long, { minCalmar: 1 });
    expect(v.undecidable).toBe(false);
    expect(typeof v.pass).toBe("boolean");
    // 样本内 vs 样本外的落差此时才有意义
    const s = summarizeWalkForward(long, [w.testMetrics]);
    expect(s.decayRatio).toBeCloseTo(1, 10); // 自比自
  });

  it("整条链重跑一遍结果逐字节一致", () => {
    const again = runWalkForward(days, {
      windowDays: 360,
      optimize: (train) => {
        const r = optimize({ grid: GRID, evaluate: (p) => evaluateOn(p, train) });
        return { params: r.best.params, metrics: r.best.metrics };
      },
      evaluate: (params, test) => evaluateOn(params, test),
    });
    expect(JSON.stringify(again)).toBe(JSON.stringify(windows));
  });
});
