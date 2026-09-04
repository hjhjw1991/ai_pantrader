import { describe, expect, it } from "vitest";
import type { BacktestMetrics } from "@/lib/contracts";
import { gridPoints, heatmap, optimize } from "@/lib/backtest/optimizer";

function metricsWith(calmar: number): BacktestMetrics {
  return {
    calmar, annualReturn: calmar * 0.1, maxDrawdown: 0.1, sharpe: 1,
    winRate: 0.5, profitFactor: 1.4, trades: 60, avgHoldDays: 4,
    triggerRate: 0.5, buyDecisions: 120, buyFilled: 60,
  };
}

/** 平缓单峰：峰在 a=4.4 / b=2，邻域衰减很慢 → 不该报过拟合 */
function smooth(p: Record<string, unknown>): BacktestMetrics {
  const a = Number(p.a), b = Number(p.b);
  return metricsWith(3 - 0.05 * (a - 4.4) ** 2 - 0.1 * (b - 2) ** 2);
}

/** 尖峰：只有一个点好，隔壁全烂 → 典型过拟合长相 */
function spike(p: Record<string, unknown>): BacktestMetrics {
  return metricsWith(Number(p.a) === 5 && Number(p.b) === 2 ? 5 : 0.5);
}

const GRID = { a: [1, 3, 5, 7, 9], b: [1, 2, 3] };

describe("网格展开", () => {
  it("笛卡尔积按轴的书写顺序展开，顺序确定", () => {
    const pts = gridPoints({ a: [1, 2], b: ["x", "y"] });
    expect(pts).toEqual([
      { a: 1, b: "x" }, { a: 1, b: "y" },
      { a: 2, b: "x" }, { a: 2, b: "y" },
    ]);
  });

  it("空网格返回一个空参数点，不是空数组", () => {
    expect(gridPoints({})).toEqual([{}]);
  });
});

describe("以 Calmar 为目标的网格寻优", () => {
  let calls = 0;
  const r = optimize({ grid: GRID, evaluate: (p) => { calls++; return smooth(p); } });

  it("找到网格上的 Calmar 最优点", () => {
    expect(r.gridSize).toBe(15);
    expect(r.evaluations).toHaveLength(15);
    expect(r.best.params).toEqual({ a: 5, b: 2 }); // 网格上离 4.4 最近的是 5
    expect(r.best.calmar).toBeCloseTo(3 - 0.05 * 0.36, 10);
  });

  it("同一份网格跑两次结果完全一致（无随机搜索）", () => {
    const a = optimize({ grid: GRID, evaluate: smooth });
    const b = optimize({ grid: GRID, evaluate: smooth });
    expect(a.evaluations).toEqual(b.evaluations);
    expect(a.best).toEqual(b.best);
  });

  it("同一组参数不重复评估", () => {
    expect(calls).toBe(15);
  });

  it("并列时取先遇到的点，结果稳定", () => {
    const flat = optimize({ grid: { a: [1, 2, 3] }, evaluate: () => metricsWith(1) });
    expect(flat.best.params).toEqual({ a: 1 });
  });
});

describe("参数敏感度与过拟合信号（spec §10.4）", () => {
  it("平缓峰：sharpness 低，不报过拟合", () => {
    const r = optimize({ grid: GRID, evaluate: smooth });
    // 邻域均值接近峰值 → 山峰平缓
    expect(r.peak.sharpness).toBeLessThan(0.3);
    expect(r.peak.overfitRisk).toBe(false);
  });

  it("尖峰：sharpness 高，明确报过拟合风险", () => {
    const r = optimize({ grid: GRID, evaluate: spike });
    expect(r.best.calmar).toBe(5);
    expect(r.peak.neighbourMeanCalmar).toBe(0.5);
    expect(r.peak.sharpness).toBeCloseTo(1 - 0.5 / 5, 10);
    expect(r.peak.overfitRisk).toBe(true);
    expect(r.warnings.join(" ")).toContain("过拟合");
  });

  it("每个轴都出敏感度曲线，供画热力图", () => {
    const r = optimize({ grid: GRID, evaluate: smooth });
    const axisA = r.sensitivity.find((s) => s.axis === "a")!;
    expect(axisA.points.map((p) => p.value)).toEqual([1, 3, 5, 7, 9]);
    // a=5 时的最好成绩 = b 取最优时的值
    expect(axisA.points[2].bestCalmar).toBeCloseTo(r.best.calmar, 10);
    expect(axisA.points[2].meanCalmar).toBeLessThan(axisA.points[2].bestCalmar);
    expect(r.sensitivity.map((s) => s.axis)).toEqual(["a", "b"]);
  });

  it("热力图给出二维网格，缺失组合为 null", () => {
    const r = optimize({ grid: GRID, evaluate: smooth });
    const h = heatmap(r.evaluations, "a", "b");
    expect(h.x).toEqual([1, 3, 5, 7, 9]);
    expect(h.y).toEqual([1, 2, 3]);
    expect(h.cells).toHaveLength(3);   // 行 = y
    expect(h.cells[0]).toHaveLength(5); // 列 = x
    expect(h.cells[1][2]).toBeCloseTo(r.best.calmar, 10); // (a=5,b=2)
    const h2 = heatmap([r.evaluations[0]], "a", "b");
    expect(h2.cells[0][0]).not.toBe(null);
  });
});

describe("由粗到精", () => {
  it("在最优点两侧插中点，逐轴推进，能逼近真峰 4.4", () => {
    const coarse = optimize({ grid: GRID, evaluate: smooth });
    expect(coarse.best.params.a).toBe(5);

    const fine = optimize({ grid: GRID, evaluate: smooth, refineRounds: 1 });
    // a 轴插 4 与 6，b 轴插 1.5 与 2.5 → 15 + 4 次评估
    expect(fine.evaluations).toHaveLength(19);
    expect(fine.best.params).toEqual({ a: 4, b: 2 });
    expect(fine.best.calmar).toBeGreaterThan(coarse.best.calmar);
    expect(fine.refinedRounds).toBe(1);
  });

  it("非数值轴不参与细化（没有中点可插）", () => {
    const r = optimize({
      grid: { mode: ["宽", "严"], a: [1, 3, 5] },
      evaluate: (p) => metricsWith(p.mode === "严" ? Number(p.a) * 0.1 : 0.2),
      refineRounds: 1,
    });
    // 6 个粗网格点 + a 轴 1 个中点（最优 a=5 只有下侧邻居 3 → 中点 4）
    expect(r.evaluations).toHaveLength(7);
    expect(r.best.params.mode).toBe("严");
  });
});

describe("退化结果不许被当成寻优成果", () => {
  it("全网格 Calmar 都是 0（样本退化）时明确警告", () => {
    const r = optimize({ grid: GRID, evaluate: () => metricsWith(0) });
    expect(r.best.calmar).toBe(0);
    expect(r.warnings.join(" ")).toContain("无效");
    expect(r.peak.overfitRisk).toBe(false);
  });

  it("最优 Calmar 为负同样警告", () => {
    const r = optimize({ grid: GRID, evaluate: () => metricsWith(-0.4) });
    expect(r.warnings.join(" ")).toContain("无效");
  });
});
