/**
 * 影子盘统计：每个变体一份成绩单，外加与 baseline 的差异检验。
 * 毕业门槛（④期3）直接读这里的数，口径必须钉死。
 */
import { describe, it, expect } from "vitest";
import { summarize, welch, maxDrawdown, type Trade } from "@/lib/shadow/stats";

const tr = (net: number, over: Partial<Trade> = {}): Trade => ({
  status: "已结算", netPct: net, exitDate: "2026-09-01", exitReason: "期满", stage: null, baseDate: "2026-08-25", ...over,
});

describe("summarize", () => {
  it("胜率 = 净收益 > 0 的占比；触发率 = 已结算 / (已结算 + 未触发)", () => {
    const s = summarize([tr(2), tr(-1), tr(3), { ...tr(0), status: "未触发", netPct: null }]);
    expect(s.settled).toBe(3);
    expect(s.untriggered).toBe(1);
    expect(s.triggerRate).toBeCloseTo(0.75, 9);
    expect(s.winRate).toBeCloseTo(2 / 3, 6);
  });

  it("期望 = 平均净收益；盈亏比 = 平均盈利 / |平均亏损|", () => {
    const s = summarize([tr(4), tr(2), tr(-1), tr(-3)]);
    expect(s.meanNet).toBeCloseTo(0.5, 9);
    expect(s.payoff).toBeCloseTo(3 / 2, 9);
  });

  it("没有亏损 → 盈亏比 null（不是无穷大，也不是 0）", () => {
    expect(summarize([tr(1), tr(2)]).payoff).toBeNull();
  });

  it("按离场原因与阶段拆分", () => {
    const s = summarize([tr(3, { exitReason: "目标", stage: "发酵" }), tr(-2, { exitReason: "止损", stage: "退潮" }), tr(1, { stage: "发酵" })]);
    expect(s.byExit).toMatchObject({ 目标: 1, 止损: 1, 期满: 1 });
    expect(s.byStage["发酵"]).toMatchObject({ n: 2, meanNet: 2 });
    expect(s.byStage["退潮"]).toMatchObject({ n: 1, meanNet: -2 });
  });

  it("空样本 → 各项 null，不报 NaN", () => {
    const s = summarize([]);
    expect(s.meanNet).toBeNull();
    expect(s.winRate).toBeNull();
    expect(s.maxDrawdown).toBeNull();
  });
});

describe("maxDrawdown（逐笔等权累加，按离场日排序）", () => {
  it("累计曲线 2, 5, 1, 3 → 回撤 4", () => {
    const ts = [tr(2, { exitDate: "2026-01-01" }), tr(3, { exitDate: "2026-01-02" }), tr(-4, { exitDate: "2026-01-03" }), tr(2, { exitDate: "2026-01-04" })];
    expect(maxDrawdown(ts)).toBeCloseTo(4, 9);
  });
  it("离场日乱序也按日期排", () => {
    const ts = [tr(-4, { exitDate: "2026-01-03" }), tr(2, { exitDate: "2026-01-01" }), tr(3, { exitDate: "2026-01-02" })];
    expect(maxDrawdown(ts)).toBeCloseTo(4, 9);
  });
  it("一路赚 → 0", () => {
    expect(maxDrawdown([tr(1), tr(2)])).toBe(0);
  });
});

describe("welch（两组均值差的 t）", () => {
  it("两组相同 → t = 0", () => {
    expect(welch([1, 2, 3], [1, 2, 3])!.t).toBeCloseTo(0, 9);
  });
  it("已知数值", () => {
    // a 均值 5 方差 2.5 (n=5)，b 均值 3 方差 2.5 (n=5)：se = sqrt(0.5+0.5)=1，t = 2
    const r = welch([3, 4, 5, 6, 7], [1, 2, 3, 4, 5])!;
    expect(r.diff).toBeCloseTo(2, 9);
    expect(r.t).toBeCloseTo(2, 9);
  });
  it("任一组少于 2 个 → null（算不出方差，不给一个假的 t）", () => {
    expect(welch([1], [1, 2, 3])).toBeNull();
  });
});
