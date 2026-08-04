import type { BacktestMetrics } from "@/lib/contracts";
import { canonicalJson } from "@/lib/backtest/hash";

/**
 * 参数寻优（spec §10.4）：网格 + 由粗到精，目标 **Calmar**。
 *
 * 刻意不做随机搜索 / 遗传 / 贝叶斯优化。理由不是它们不好，是：
 *   1. 可复现性优先（spec §17 断言 4）—— 随机搜索每跑一次给一组不同参数，
 *      没法回答"上周那份报告是怎么来的"；
 *   2. 参数轴就那么几条、取值范围人也说得清，网格够用；
 *   3. 更聪明的搜索更容易在噪音里找到尖峰，而尖峰恰恰是要躲的东西。
 *
 * 因此本模块的产出除了最优点，还必须给出**敏感度**：山峰陡峭 = 过拟合信号。
 * 一个只在 (a=5,b=2) 好、隔壁全烂的参数点不是发现，是巧合。
 */

export type ParamGrid = Record<string, readonly unknown[]>;

export interface Evaluation {
  params: Record<string, unknown>;
  calmar: number;
  metrics: BacktestMetrics;
}

export interface SensitivityPoint {
  value: unknown;
  /** 该取值下所有组合中的最好 Calmar */
  bestCalmar: number;
  /** 该取值下的平均 Calmar，比 best 更能看出这条轴稳不稳 */
  meanCalmar: number;
}

export interface SensitivityAxis {
  axis: string;
  points: SensitivityPoint[];
}

export interface PeakShape {
  /** 1 − 邻域均值/峰值。越接近 1 = 山峰越陡 = 越像过拟合 */
  sharpness: number;
  neighbourMeanCalmar: number;
  overfitRisk: boolean;
}

export interface OptimizeOptions {
  grid: ParamGrid;
  evaluate: (params: Record<string, unknown>) => BacktestMetrics;
  /** 由粗到精轮数，默认 0（纯网格）。只对数值轴有效 */
  refineRounds?: number;
  /** 陡峰判定阈值，默认 0.5：邻域均值掉到峰值一半以下就报风险 */
  peakThreshold?: number;
}

export interface OptimizeResult {
  best: Evaluation;
  /** 全部评估点，按评估顺序。热力图与敏感度都从这里算 */
  evaluations: Evaluation[];
  sensitivity: SensitivityAxis[];
  peak: PeakShape;
  gridSize: number;
  refinedRounds: number;
  warnings: string[];
}

/** 笛卡尔积，按轴的书写顺序展开 —— 顺序确定，结果才可复现 */
export function gridPoints(grid: ParamGrid): Array<Record<string, unknown>> {
  const axes = Object.keys(grid);
  let out: Array<Record<string, unknown>> = [{}];
  for (const axis of axes) {
    const next: Array<Record<string, unknown>> = [];
    for (const base of out) {
      for (const v of grid[axis]) next.push({ ...base, [axis]: v });
    }
    out = next;
  }
  return out;
}

function keyOf(p: Record<string, unknown>): string {
  return canonicalJson(p);
}

function numericAscending(values: readonly unknown[]): number[] | null {
  if (values.length === 0 || !values.every((v) => typeof v === "number" && Number.isFinite(v))) return null;
  return [...(values as number[])].sort((a, b) => a - b);
}

export function optimize(o: OptimizeOptions): OptimizeResult {
  const peakThreshold = o.peakThreshold ?? 0.5;
  const evaluations: Evaluation[] = [];
  const seen = new Map<string, Evaluation>();
  // 各轴的已探索取值，细化时会往里加中点
  const axisValues: Record<string, unknown[]> = {};
  for (const a of Object.keys(o.grid)) axisValues[a] = [...o.grid[a]];

  const evalOnce = (params: Record<string, unknown>): Evaluation => {
    const k = keyOf(params);
    const hit = seen.get(k);
    if (hit) return hit;
    const metrics = o.evaluate(params);
    const e: Evaluation = { params, calmar: metrics.calmar, metrics };
    seen.set(k, e);
    evaluations.push(e);
    return e;
  };

  const coarse = gridPoints(o.grid);
  let best: Evaluation | null = null;
  for (const p of coarse) {
    const e = evalOnce(p);
    // 严格大于：并列取先遇到的，保证同一份输入永远给同一个答案
    if (!best || e.calmar > best.calmar) best = e;
  }
  if (!best) best = evalOnce({});

  // 由粗到精：逐轴在当前最优点两侧插中点。用当前最优（而非本轮初始最优）推进，
  // 顺序是轴的书写顺序 —— 顺序固定才谈得上确定性
  const rounds = o.refineRounds ?? 0;
  for (let round = 0; round < rounds; round++) {
    for (const axis of Object.keys(o.grid)) {
      const sorted = numericAscending(axisValues[axis]);
      if (!sorted) continue; // 非数值轴没有中点可插
      const cur = Number(best!.params[axis]);
      const idx = sorted.indexOf(cur);
      if (idx < 0) continue;
      const mids: number[] = [];
      if (idx > 0) mids.push((sorted[idx - 1] + cur) / 2);
      if (idx < sorted.length - 1) mids.push((cur + sorted[idx + 1]) / 2);
      for (const m of mids) {
        if (axisValues[axis].some((v) => v === m)) continue;
        axisValues[axis].push(m);
        const e = evalOnce({ ...best!.params, [axis]: m });
        if (e.calmar > best!.calmar) best = e;
      }
    }
  }

  const sensitivity: SensitivityAxis[] = Object.keys(o.grid).map((axis) => ({
    axis,
    points: (o.grid[axis]).map((value) => {
      const subset = evaluations.filter((e) => e.params[axis] === value);
      const cs = subset.map((e) => e.calmar);
      return {
        value,
        bestCalmar: cs.length === 0 ? 0 : Math.max(...cs),
        meanCalmar: cs.length === 0 ? 0 : cs.reduce((a, b) => a + b, 0) / cs.length,
      };
    }),
  }));

  // 邻域 = 只改一条轴、且改到相邻取值的点。它们的均值反映峰有多孤立
  const neighbours: number[] = [];
  for (const axis of Object.keys(o.grid)) {
    const sorted = numericAscending(axisValues[axis]) ?? [...axisValues[axis]].map((_, i) => i);
    const vals = numericAscending(axisValues[axis]) ? sorted : axisValues[axis];
    const idx = (vals as unknown[]).findIndex((v) => v === best!.params[axis]);
    if (idx < 0) continue;
    for (const j of [idx - 1, idx + 1]) {
      if (j < 0 || j >= (vals as unknown[]).length) continue;
      const probe = { ...best!.params, [axis]: (vals as unknown[])[j] };
      const hit = seen.get(keyOf(probe));
      if (hit) neighbours.push(hit.calmar);
    }
  }
  const neighbourMeanCalmar = neighbours.length === 0
    ? best!.calmar
    : neighbours.reduce((a, b) => a + b, 0) / neighbours.length;
  const sharpness = best!.calmar > 0 ? 1 - neighbourMeanCalmar / best!.calmar : 0;
  const overfitRisk = best!.calmar > 0 && sharpness > peakThreshold;

  const warnings: string[] = [];
  if (best!.calmar <= 0) {
    warnings.push(
      `最优点 Calmar=${best!.calmar.toFixed(4)} ≤ 0，寻优结论无效：` +
      "要么样本退化被 metrics 记了 0（区间不足一年/笔数不足/零回撤），要么这套参数确实不赚钱。"
    );
  }
  if (overfitRisk) {
    warnings.push(
      `参数敏感度陡峰：邻域均值 ${neighbourMeanCalmar.toFixed(3)} vs 峰值 ${best!.calmar.toFixed(3)}` +
      `（sharpness=${sharpness.toFixed(2)} > ${peakThreshold}），过拟合风险高 —— 宁可取平缓区的次优点。`
    );
  }

  return {
    best: best!, evaluations, sensitivity,
    peak: { sharpness, neighbourMeanCalmar, overfitRisk },
    gridSize: coarse.length, refinedRounds: rounds, warnings,
  };
}

export interface Heatmap {
  axisX: string;
  axisY: string;
  x: unknown[];
  y: unknown[];
  /** cells[y][x] = 该组合下的最好 Calmar；没评估过的组合为 null */
  cells: Array<Array<number | null>>;
}

/** 参数敏感度热力图数据（spec §10.4）。前端画图，判断的还是"峰陡不陡" */
export function heatmap(evaluations: Evaluation[], axisX: string, axisY: string): Heatmap {
  const xs = uniqueSorted(evaluations.map((e) => e.params[axisX]));
  const ys = uniqueSorted(evaluations.map((e) => e.params[axisY]));
  const cells: Array<Array<number | null>> = ys.map(() => xs.map(() => null));
  for (const e of evaluations) {
    const xi = xs.indexOf(e.params[axisX]);
    const yi = ys.indexOf(e.params[axisY]);
    if (xi < 0 || yi < 0) continue;
    const cur = cells[yi][xi];
    cells[yi][xi] = cur === null ? e.calmar : Math.max(cur, e.calmar);
  }
  return { axisX, axisY, x: xs, y: ys, cells };
}

function uniqueSorted(values: unknown[]): unknown[] {
  const out = [...new Set(values)];
  const allNum = out.every((v) => typeof v === "number");
  return allNum ? (out as number[]).sort((a, b) => a - b) : out.map(String).sort();
}
