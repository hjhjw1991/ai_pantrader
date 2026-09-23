/**
 * 估值分位：PE 在申万一级行业内（同行不足时退回全市场）的横截面分位。
 * 只做粗筛 —— "资金跑出来的龙头"本就不看便宜，只防行业里最离谱的那一撮。
 */
import { describe, it, expect } from "vitest";
import { VALUATION_FACTORS } from "@/lib/factors/valuation";
import type { FactorSpec, PointInTimeView } from "@/lib/contracts";
import { makeView, sec } from "./view-double";

function run<T>(view: PointInTimeView, params: Record<string, unknown> = {}) {
  const spec = VALUATION_FACTORS[0] as FactorSpec<T>;
  return spec.fn({ view, params: { ...spec.defaults, code: "600000", ...params } });
}

const DATE = "2026-09-23";
/** 半导体 12 只 PE 10..120，银行 12 只 PE 4..15；被测票 600000 的 PE 与行业可调 */
function market(pe: number | null, ind = "半导体", opt: { date?: string; peers?: number } = {}) {
  const rows: Array<{ code: string; pe: number | null; pb: null; mktcap: null }> = [];
  const inds: Array<{ code: string; indexCode: string; indexName: string }> = [];
  const n = opt.peers ?? 12;
  for (let i = 0; i < n; i++) {
    rows.push({ code: `3000${String(i).padStart(2, "0")}`, pe: 10 + i * 10, pb: null, mktcap: null });
    inds.push({ code: `3000${String(i).padStart(2, "0")}`, indexCode: "801080", indexName: "半导体" });
  }
  for (let i = 0; i < 12; i++) {
    rows.push({ code: `6010${String(i).padStart(2, "0")}`, pe: 4 + i, pb: null, mktcap: null });
    inds.push({ code: `6010${String(i).padStart(2, "0")}`, indexCode: "801780", indexName: "银行" });
  }
  rows.push({ code: "600000", pe, pb: null, mktcap: null });
  inds.push({ code: "600000", indexCode: ind === "银行" ? "801780" : "801080", indexName: ind });
  return makeView({
    asOf: DATE, tradingDays: ["2026-09-14", "2026-09-15", "2026-09-16", "2026-09-17", "2026-09-18", "2026-09-21", "2026-09-22", DATE],
    securities: [sec("600000", "主板")],
    valuationCs: { date: opt.date ?? DATE, rows }, industries1: inds,
  });
}

describe("估值分位", () => {
  it("同样 PE 30：在半导体里偏便宜，在银行里偏贵 —— 所以要按行业比", () => {
    const semi = run<number>(market(30, "半导体"));
    const bank = run<number>(market(30, "银行"));
    expect(semi.value!).toBeLessThan(0.3);
    expect(bank.value!).toBeGreaterThan(0.9);
    expect(bank.label).toBe("偏贵");
    expect(bank.inputs?.口径).toBe("行业");
    expect(bank.inputs?.行业).toBe("银行");
  });

  it("inputs 带同行中位 PE 与相对倍数 —— 「比同行贵 3 倍」比一个分位数好懂", () => {
    const r = run<any>(market(30, "银行"));
    expect(r.inputs?.同行中位PE).toBeCloseTo(9.5, 6);
    expect(r.inputs?.相对中位).toBeCloseTo(30 / 9.5, 6);
  });

  it("同行（正 PE）不足 10 家 → 退回全市场分位", () => {
    const r = run<any>(market(30, "半导体", { peers: 5 }));
    expect(r.inputs?.口径).toBe("全市场");
  });

  it("PE 为负 = 亏损：值 null、标签「亏损」，是真实读数（置信 1），不是缺数据", () => {
    const r = run<number>(market(-12));
    expect(r.value).toBeNull();
    expect(r.label).toBe("亏损");
    expect(r.confidence).toBe(1);
  });

  it("没有估值快照 → 置信 0", () => {
    const v = makeView({ asOf: DATE, securities: [sec("600000", "主板")] });
    expect(run<number>(v).confidence).toBe(0);
  });

  it("快照比评估日晚了 5 个交易日以上 → 估值过旧，置信 0（不拿上周的价格比今天的贵贱）", () => {
    const r = run<number>(market(30, "银行", { date: "2026-09-14" }));
    expect(r.label).toBe("估值过旧");
    expect(r.confidence).toBe(0);
  });

  it("回放：快照日晚于评估日 → 当作没有（那是未来的 PE）", () => {
    const r = run<any>(market(30, "银行"), { 日期: "2026-09-21" });
    expect(r.confidence).toBe(0);
    expect(r.inputs?.快照日).toBe(DATE);
  });

  it("快照里没有这只票 → 置信 0", () => {
    const r = run<number>(market(30), { code: "688999" });
    expect(r.confidence).toBe(0);
  });
});
