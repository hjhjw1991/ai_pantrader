import { describe, expect, it } from "vitest";
import {
  ADJ_FACTOR_GAP, buildCoverageReport, formatCoverageHeader,
} from "@/lib/backtest/coverage";
import { fakeTradingDays } from "./helpers/fixtures";

/** 2022-01-03 起约 1150 个"weekday 交易日"，够跨过复权断层 */
const days = fakeTradingDays("2022-01-03", 1150);
const first = days[0];
const last = days[days.length - 1];

describe("覆盖率报告（spec §10.5）", () => {
  it("复权断层把有效区间从 4 年砍到 2023-12 之后（spec R1）", () => {
    const r = buildCoverageReport({
      requested: { from: first, to: last },
      tradingDays: days,
      replayedDays: days,
      skippedDays: [],
    });
    expect(ADJ_FACTOR_GAP).toEqual({ from: "2022-05-01", to: "2023-12-31" });
    expect(r.effectiveRange.from >= "2024-01-01").toBe(true);
    expect(r.effectiveRange.from).toBe(days.find((d) => d >= "2024-01-01"));
    expect(r.effectiveRange.to).toBe(last);
    // 被砍掉的是 2022-01 至 2023-12 的全部交易日
    expect(r.truncatedDays).toBe(days.filter((d) => d < "2024-01-01").length);
    expect(r.notes.join(" ")).toContain("复权");
    expect(r.notes.join(" ")).toContain("R1");
  });

  it("覆盖率只按有效区间算，缺口日计入分母", () => {
    const effective = days.filter((d) => d >= "2024-01-01");
    const skipped = effective.slice(10, 15); // 5 个缺口日
    const r = buildCoverageReport({
      requested: { from: first, to: last },
      tradingDays: days,
      replayedDays: effective.filter((d) => !skipped.includes(d)),
      skippedDays: skipped,
    });
    expect(r.gapDays).toBe(5);
    expect(r.coverage).toBeCloseTo((effective.length - 5) / effective.length, 10);
    expect(r.coverage).toBeLessThan(1);
  });

  it("复权断层解决后（R1 攻下）有效区间等于请求区间", () => {
    const r = buildCoverageReport({
      requested: { from: first, to: last },
      tradingDays: days,
      replayedDays: days,
      skippedDays: [],
      adjFactorResolved: true,
    });
    expect(r.effectiveRange.from).toBe(first);
    expect(r.truncatedDays).toBe(0);
    expect(r.coverage).toBe(1);
    expect(r.notes.join(" ")).not.toContain("复权断层");
  });

  it("只有 ρ<0.8 的因子进首页清单，按 ρ 升序", () => {
    const r = buildCoverageReport({
      requested: { from: first, to: last },
      tradingDays: days, replayedDays: days, skippedDays: [],
      lowConfidenceFactors: [
        { name: "涨停家数", rho: 0.93 },
        { name: "炸板率", rho: 0.61 },
        { name: "连板高度", rho: 0.78 },
      ],
    });
    expect(r.lowConfidenceFactors).toEqual([
      { name: "炸板率", rho: 0.61 },
      { name: "连板高度", rho: 0.78 },
    ]);
  });

  it("有效区间不足一年要显式提示（别拿 3 个月当 4 年）", () => {
    const short = days.filter((d) => d >= "2026-01-01");
    const r = buildCoverageReport({
      requested: { from: first, to: last },
      tradingDays: days, replayedDays: short, skippedDays: [],
    });
    expect(r.effectiveYears).toBeLessThan(1);
    expect(r.notes.join(" ")).toContain("不足一年");
  });

  it("一天都没回放到时覆盖率为 0，不产生 NaN", () => {
    const r = buildCoverageReport({
      requested: { from: first, to: last },
      tradingDays: days, replayedDays: [], skippedDays: [],
    });
    expect(r.coverage).toBe(0);
    expect(Number.isFinite(r.coverage)).toBe(true);
    expect(r.effectiveRange).toEqual({ from: "", to: "" });
  });

  it("首页文本必须写出有效区间，而不是让人以为测了全程", () => {
    const r = buildCoverageReport({
      requested: { from: first, to: last },
      tradingDays: days,
      replayedDays: days.filter((d) => d >= "2024-01-01").slice(0, 300),
      skippedDays: ["2024-03-01"],
      lowConfidenceFactors: [{ name: "炸板率", rho: 0.61 }],
    });
    const header = formatCoverageHeader(r);
    expect(header).toContain("有效区间");
    expect(header).toContain(r.effectiveRange.from);
    expect(header).toContain("请求区间");
    expect(header).toContain(first); // 请求区间也要写出来，供对比
    expect(header).toContain("低置信因子");
    expect(header).toContain("炸板率");
    expect(header).toContain("ρ=0.61");
    expect(header).toContain("gap");
  });
});
