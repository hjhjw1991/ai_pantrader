import { describe, it, expect } from "vitest";
import { selectionBias, expectedMaxSigma } from "@/lib/backtest/selection-bias";

/**
 * 选择偏差。
 *
 * 寻优就是"试 N 个组合取最好的那个"，而这个最好天然被抬高 ——
 * 抬高量可以算：约 σ·sqrt(2·ln N)。不减掉它，人看到的是"最优 Calmar 1.9"，
 * 而这个 1.9 里有 1.4 是挑选动作送的。
 *
 * 这些测试守住三件事：天花板随 N 涨、真信号能超出天花板、运气型超不过。
 */
describe("运气天花板", () => {
  it("只试 1 次谈不上选择偏差", () => {
    expect(expectedMaxSigma(1)).toBe(0);
    expect(expectedMaxSigma(0)).toBe(0);
  });

  it("试得越多，纯靠挑能挑到的就越高（单调）", () => {
    const xs = [1, 2, 4, 9, 16, 36, 100].map(expectedMaxSigma);
    for (let i = 1; i < xs.length; i++) expect(xs[i]!).toBeGreaterThan(xs[i - 1]!);
  });

  it("N=36 约 2.68σ —— 量级必须对得上", () => {
    // 36 次抽样取最大，那个最大值的期望比均值高约 2.68 个标准差
    expect(expectedMaxSigma(36)).toBeCloseTo(2.68, 1);
  });
});

describe("选择偏差判定", () => {
  it("没有评估点时如实说没测，不脑补", () => {
    const r = selectionBias([]);
    expect(r.trials).toBe(0);
    expect(r.overfitSuspected).toBe(false);
    expect(r.note).toMatch(/谈不上/);
  });

  it("只试一个组合：最好就是均值，没有可减的运气", () => {
    const r = selectionBias([1.5]);
    expect(r.trials).toBe(1);
    expect(r.chanceCeiling).toBe(1.5);
    expect(r.deflated).toBe(0);
    // deflated=0 是"没挑过"，不是"被运气解释掉" —— 不能报嫌疑（否则界面标红、optimizer 自相矛盾）
    expect(r.overfitSuspected).toBe(false);
    expect(r.note).toMatch(/无选择偏差/);
  });

  it("真信号：最优点远超运气能给的高度 → 不报", () => {
    // 一片 1.0 附近的高原（抖动 ±0.05），外加一个真正突出的 2.0：
    // 均值约 1.03、sd 约 0.17，天花板约 1.48，而最优点 2.0 —— 扣掉运气还剩 0.5
    const calmars = Array.from({ length: 35 }, (_, i) => 1 + ((i % 5) - 2) * 0.025);
    calmars.push(2.0);
    const r = selectionBias(calmars);
    expect(r.deflated).toBeGreaterThan(0);
    expect(r.overfitSuspected).toBe(false);
  });

  it("运气型：一堆平庸点里挑出来的尖子 → 报过拟合嫌疑", () => {
    // 0 到 1 均匀铺开的 36 个点（均值 0.5、sd≈0.29）：
    // 光靠挑最好那个就能挑到 0.5 + 0.29×2.68 ≈ 1.28，而最优点只有 1.0
    const calmars = Array.from({ length: 36 }, (_, i) => i / 35);
    const r = selectionBias(calmars);
    expect(r.chanceCeiling).toBeGreaterThan(1.2);
    expect(r.deflated).toBeLessThan(0);
    expect(r.overfitSuspected).toBe(true);
  });

  it("所有组合成绩一样（无区分度）：挑出来的最好没有超出运气", () => {
    const r = selectionBias(Array.from({ length: 36 }, () => 0.8));
    expect(r.sd).toBe(0);
    expect(r.deflated).toBe(0);
    expect(r.overfitSuspected).toBe(true);
  });

  it("试得越多，同一个最好成绩的嫌疑越大 —— 次数就是代价", () => {
    // 同一批成绩（均值 0.6、sd≈0.32、最好 1.0）分别试 5 次和 35 次：
    // 分布一模一样，唯一的区别是挑了多少次 —— 天花板就该跟着次数涨
    const few = selectionBias([0.2, 0.4, 0.6, 0.8, 1.0]);
    const many = selectionBias(Array.from({ length: 7 }, () => [0.2, 0.4, 0.6, 0.8, 1.0]).flat());
    expect(many.trials).toBe(35);
    // 同一批成绩、均值相同；样本 sd 会略降（n/(n−1) 的修正因子随 n 收敛），
    // 这是样本标准差的正常行为，不是判定变了
    expect(many.mean).toBeCloseTo(few.mean, 4);
    expect(many.sd).toBeCloseTo(few.sd, 1);
    expect(many.chanceCeiling).toBeGreaterThan(few.chanceCeiling);
    expect(many.deflated).toBeLessThan(few.deflated);
  });

  it("非有限值过滤掉，不让一个 NaN 把整份判定污染成 NaN", () => {
    const r = selectionBias([0.5, Number.NaN, 0.6, Number.POSITIVE_INFINITY, 0.7]);
    expect(r.trials).toBe(3);
    expect(Number.isFinite(r.chanceCeiling)).toBe(true);
    expect(Number.isFinite(r.deflated)).toBe(true);
  });

  it("note 里带得走人读得懂的数：试了几次、天花板多少、剩多少", () => {
    const r = selectionBias([0.5, 0.6, 0.7, 1.4]);
    expect(r.note).toMatch(/试了 4 个组合/);
    expect(r.note).toContain(r.chanceCeiling.toFixed(2));
  });
});
