import { describe, expect, it } from "vitest";
import type { BacktestMetrics, WalkForwardWindow } from "@/lib/contracts";
import * as wf from "@/lib/backtest/walkforward";
import {
  IN_SAMPLE_RATIO, planWalkForward, runWalkForward, walkForwardVerdict,
} from "@/lib/backtest/walkforward";
import { fakeTradingDays } from "./helpers/fixtures";

const days = fakeTradingDays("2024-01-01", 250);

function metrics(calmar: number): BacktestMetrics {
  return {
    calmar, annualReturn: calmar * 0.1, maxDrawdown: 0.1, sharpe: 1,
    winRate: 0.5, profitFactor: 1.5, trades: 50, avgHoldDays: 3,
  };
}

describe("7:3 滚动切分（spec §10.4）", () => {
  const splits = planWalkForward(days, { windowDays: 100 });

  it("样本内外比例固定 7:3", () => {
    expect(IN_SAMPLE_RATIO).toBe(0.7);
    expect(splits[0].trainDays).toHaveLength(70);
    expect(splits[0].testDays).toHaveLength(30);
  });

  it("窗口按测试段长度滚动，边界精确", () => {
    expect(splits).toHaveLength(6); // (250-100)/30 + 1
    expect(splits[0].train).toEqual({ from: days[0], to: days[69] });
    expect(splits[0].test).toEqual({ from: days[70], to: days[99] });
    expect(splits[1].train).toEqual({ from: days[30], to: days[99] });
    expect(splits[1].test).toEqual({ from: days[100], to: days[129] });
    expect(splits[5].test).toEqual({ from: days[220], to: days[249] });
  });

  it("训练段与测试段绝不重叠，测试段之间也不重叠", () => {
    for (const s of splits) expect(s.train.to < s.test.from).toBe(true);
    for (let i = 1; i < splits.length; i++) {
      expect(splits[i - 1].test.to < splits[i].test.from).toBe(true);
    }
  });

  it("交易日不够一个窗口就返回空，不硬凑", () => {
    expect(planWalkForward(days.slice(0, 50), { windowDays: 100 })).toEqual([]);
    expect(runWalkForward(days.slice(0, 50), {
      windowDays: 100,
      optimize: () => ({ params: {} }),
      evaluate: () => metrics(1),
    })).toEqual([]);
  });
});

describe("样本外不过就是不过：结构上不给回调样本内的机会", () => {
  const optimizeSaw: Array<{ from: string; to: string }> = [];
  const evaluateSaw: Array<{ from: string; to: string }> = [];
  const splits = planWalkForward(days, { windowDays: 100 });

  const windows = runWalkForward(days, {
    windowDays: 100,
    optimize: (train, trainDays) => {
      optimizeSaw.push(train);
      // 寻优只能看到训练日，参数就用训练段长度编码，方便断言
      return { params: { n: trainDays.length, from: train.from } };
    },
    evaluate: (params, range) => {
      evaluateSaw.push(range);
      return metrics(1.5);
    },
  });

  it("每个窗口一次寻优、一次样本外评估", () => {
    expect(windows).toHaveLength(splits.length);
    expect(optimizeSaw).toHaveLength(splits.length);
    expect(evaluateSaw).toHaveLength(splits.length);
  });

  it("寻优只看到本窗口训练区间，且全部早于本窗口样本外", () => {
    // 注意：滚动切分下，第 k 个窗口的训练段会包含第 k−1 个窗口的样本外区间 ——
    // 这是 walk-forward 本来的样子（那段数据在第 k 个窗口的时点上已经是历史了）。
    // 被禁的不是"复用"，而是"看过第 k 窗的样本外结果之后再回头调第 k 窗的样本内"。
    optimizeSaw.forEach((r, i) => {
      expect(r).toEqual(splits[i].train);
      expect(r.to < splits[i].test.from).toBe(true);
    });
  });

  it("样本外指标一旦产出即冻结，不可事后修改", () => {
    const w = windows[0];
    expect(Object.isFrozen(w)).toBe(true);
    expect(Object.isFrozen(w.testMetrics)).toBe(true);
    expect(() => { (w.testMetrics as BacktestMetrics).calmar = 99; }).toThrow();
    // 类型上就 readonly，这里绕过类型再试一次，确认运行期也被冻住
    expect(() => { (windows as unknown as WalkForwardWindow[]).push(w); }).toThrow();
  });

  it("模块不提供任何看过样本外再回调样本内的入口", () => {
    // 导出面是白名单：加任何 retune/refit 类 API 都会让这条红
    expect(Object.keys(wf).sort()).toEqual([
      "IN_SAMPLE_RATIO", "planWalkForward", "runWalkForward", "summarizeWalkForward", "walkForwardVerdict",
    ]);
  });

  it("bestParams 与测试区间一起记进窗口，供复现", () => {
    expect(windows[0].bestParams).toEqual({ n: 70, from: days[0] });
    expect(windows[0].test).toEqual(splits[0].test);
    expect(windows[0].train).toEqual(splits[0].train);
  });
});

describe("样本外裁决", () => {
  const mk = (cs: number[]) => cs.map((c, i) => ({
    train: { from: `t${i}a`, to: `t${i}b` },
    test: { from: `s${i}a`, to: `s${i}b` },
    bestParams: {}, testMetrics: metrics(c),
  }));

  it("过半窗口不达标 → 不过，且列出具体窗口", () => {
    const v = walkForwardVerdict(mk([1.2, 0.8, -0.3, 1.5]), { minCalmar: 1 });
    expect(v.medianOosCalmar).toBeCloseTo(1.0, 10);
    expect(v.failedWindows).toHaveLength(2);
    expect(v.passRatio).toBeCloseTo(0.5, 10);
    expect(v.pass).toBe(false);
    expect(v.reasons.join(" ")).toContain("样本外");
  });

  it("全部达标 → 过", () => {
    const v = walkForwardVerdict(mk([1.2, 1.4, 1.1]), { minCalmar: 1 });
    expect(v.pass).toBe(true);
    expect(v.failedWindows).toEqual([]);
  });

  it("窗口数为 0 → 不过（没测过就是没过，不是默认通过）", () => {
    const v = walkForwardVerdict([], { minCalmar: 1 });
    expect(v.pass).toBe(false);
    expect(v.reasons.join(" ")).toContain("没有");
  });

  it("样本内外落差过大要单独点出来（过拟合信号）", () => {
    const s = wf.summarizeWalkForward(mk([0.2, 0.1, 0.3]), [metrics(3), metrics(3.2), metrics(2.8)]);
    expect(s.meanInSampleCalmar).toBeCloseTo(3, 10);
    expect(s.meanOutOfSampleCalmar).toBeCloseTo(0.2, 10);
    expect(s.decayRatio).toBeCloseTo(0.2 / 3, 6);
    expect(s.overfitSuspected).toBe(true);
  });
});
