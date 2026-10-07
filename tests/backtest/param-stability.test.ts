import { describe, it, expect } from "vitest";
import { analyzeParamStability } from "@/lib/backtest/walkforward";
import type { WalkForwardWindow } from "@/lib/contracts";
import type { BacktestMetrics } from "@/lib/contracts";

/**
 * 跨窗口参数稳定性。
 *
 * 过拟合最不容易伪装的一个指纹：真规律哪段行情上都挑到同一个山头，
 * 拟合噪音换一段行情就换一组参数。bestParams 每个窗口都存了，
 * 以前没人读 —— 样本外达标但参数一路漂移，是最该警惕的那种"通过"。
 */

const m = (calmar: number): BacktestMetrics => ({
  calmar, annualReturn: 0, maxDrawdown: 0, sharpe: 0, winRate: 0, profitFactor: 0,
  trades: 0, avgHoldDays: 0, triggerRate: null, buyDecisions: 0, buyFilled: 0,
});

const win = (params: Record<string, unknown>): WalkForwardWindow => ({
  train: { from: "2024-01-01", to: "2024-06-30" },
  test: { from: "2024-07-01", to: "2024-09-30" },
  bestParams: params,
  testMetrics: m(1.5),
});

describe("参数稳定性", () => {
  it("每个窗口都挑到同一组参数 → 稳定", () => {
    const r = analyzeParamStability([win({ a: 1, b: true }), win({ a: 1, b: true }), win({ a: 1, b: true })]);
    expect(r.unstable).toBe(false);
    expect(r.axes.every((a) => a.distinct === 1)).toBe(true);
    expect(r.axes.every((a) => a.switches === 0)).toBe(true);
    expect(r.note).toMatch(/一致/);
  });

  it("一条轴一路漂移 → 判这条轴不稳，另一条不受牵连", () => {
    const r = analyzeParamStability([
      win({ a: 0.1, b: true }), win({ a: 0.2, b: true }),
      win({ a: 0.3, b: true }), win({ a: 0.4, b: true }),
    ]);
    expect(r.unstable).toBe(true);
    expect(r.unstableAxes).toEqual(["a"]);
    // 众数只占 1/4：没有任何取值站得住
    expect(r.axes.find((a) => a.axis === "a")!.modeShare).toBeCloseTo(0.25, 4);
    expect(r.axes.find((a) => a.axis === "a")!.distinct).toBe(4);
    expect(r.axes.find((a) => a.axis === "b")!.unstable).toBe(false);
    expect(r.note).toMatch(/拟合噪音/);
  });

  it("多数窗口一致、偶有一次不同 → 不算不稳（有众数撑着）", () => {
    const r = analyzeParamStability([
      win({ a: 1 }), win({ a: 1 }), win({ a: 1 }), win({ a: 1 }), win({ a: 2 }), win({ a: 1 }),
    ]);
    expect(r.unstable).toBe(false);
    expect(r.axes[0]!.modeShare).toBeCloseTo(5 / 6, 4);
  });

  it("只有两个窗口时不判 —— 两点成不了分布，判了是掷骰子", () => {
    const r = analyzeParamStability([win({ a: 1 }), win({ a: 9 })]);
    expect(r.undecidable).toBe(true);
    expect(r.unstable).toBe(false);
    expect(r.note).toMatch(/不足以判断/);
  });

  it("没有寻优轴时不假报稳定 —— 参数是空集谈不上'验证过'", () => {
    // 每个窗口都跑同一套配置（没给 --grid）："参数一致"是本来如此，
    // 不是验证过的结论。报"稳定/真山头"是最危险的一种假通过 —— 长得和真通过一样
    const r = analyzeParamStability([win({}), win({}), win({}), win({})]);
    expect(r.axes).toEqual([]);
    expect(r.undecidable).toBe(true);
    expect(r.unstable).toBe(false);
    expect(r.note).not.toMatch(/一致|真山头/);
    expect(r.note).toMatch(/没有寻优参数/);
  });

  it("没有窗口时如实说无从判断，不默认成稳定", () => {
    const r = analyzeParamStability([]);
    expect(r.undecidable).toBe(true);
    expect(r.axes).toEqual([]);
    expect(r.note).toMatch(/无从判断/);
  });

  it("布尔轴同样按取值比较，不靠 === 撞类型", () => {
    const r = analyzeParamStability([
      win({ on: true }), win({ on: false }), win({ on: true }), win({ on: false }), win({ on: true }),
    ]);
    const on = r.axes.find((a) => a.axis === "on")!;
    expect(on.distinct).toBe(2);
    // 5 个窗口里换了 4 次：一半以上的边界都在换参数
    expect(on.switches).toBe(4);
    expect(on.unstable).toBe(true);
  });

  it("窗口之间参数完全一致但取值换了类型（1 vs true）算两个值", () => {
    const r = analyzeParamStability([win({ v: 1 }), win({ v: true }), win({ v: 1 })]);
    expect(r.axes[0]!.distinct).toBe(2);
  });
});
