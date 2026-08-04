import { describe, it, expect } from "vitest";
import { MACRO_FACTORS, DEFAULT_MACRO_SYMBOLS } from "@/lib/factors/macro";
import type { MacroRow } from "@/lib/contracts";
import { makeView } from "./view-double";

const spec = MACRO_FACTORS.find(f => f.name === "外围传导")!;
const run = (macro: Record<string, MacroRow[]>, params: Record<string, unknown> = {}) =>
  spec.fn({ view: makeView({ asOf: "2026-08-03", macro }), params: { ...spec.defaults, ...params } });

const row = (symbol: string, pct: number): MacroRow =>
  ({ ts: "2026-08-03 06:00:00", symbol, price: 100, pct });

describe("外围传导 —— macro 表现在是空的，必须优雅降级", () => {
  it("全空：不抛错、value 为 null、confidence 0", () => {
    const r = run({});
    expect(() => run({})).not.toThrow();
    expect(r.value).toBeNull();
    expect(r.confidence).toBe(0);
    expect(r.label).toContain("未积累");
    expect(r.inputs?.["缺失标的"]).toEqual(Object.values(DEFAULT_MACRO_SYMBOLS));
  });

  it("全空时绝不能把读数当成 0 —— 0 会被择时读成'外围中性'", () => {
    const r = run({});
    expect(r.value).not.toBe(0);
  });

  it("部分有数据：按可得权重归一化，confidence 打折并列出缺失", () => {
    const r = run({ [DEFAULT_MACRO_SYMBOLS.A50]: [row(DEFAULT_MACRO_SYMBOLS.A50, -2)] });
    expect(r.value).toBeCloseTo(-2, 6);
    expect(r.confidence).toBeGreaterThan(0);
    expect(r.confidence).toBeLessThan(0.8);
    expect(r.inputs?.["缺失标的"]).toContain(DEFAULT_MACRO_SYMBOLS.费半);
  });

  it("A50 与费半齐跌 → risk_off", () => {
    const r = run({
      [DEFAULT_MACRO_SYMBOLS.A50]: [row(DEFAULT_MACRO_SYMBOLS.A50, -1.5)],
      [DEFAULT_MACRO_SYMBOLS.费半]: [row(DEFAULT_MACRO_SYMBOLS.费半, -3)],
      [DEFAULT_MACRO_SYMBOLS.黄金]: [row(DEFAULT_MACRO_SYMBOLS.黄金, 0.5)],
      [DEFAULT_MACRO_SYMBOLS.原油]: [row(DEFAULT_MACRO_SYMBOLS.原油, -0.5)],
    });
    expect(r.value as number).toBeLessThan(-1);
    expect(r.label).toBe("risk_off");
    expect(r.confidence).toBeGreaterThan(0.7);
  });

  it("齐涨 → risk_on", () => {
    const r = run({
      [DEFAULT_MACRO_SYMBOLS.A50]: [row(DEFAULT_MACRO_SYMBOLS.A50, 1.2)],
      [DEFAULT_MACRO_SYMBOLS.费半]: [row(DEFAULT_MACRO_SYMBOLS.费半, 2.5)],
      [DEFAULT_MACRO_SYMBOLS.黄金]: [row(DEFAULT_MACRO_SYMBOLS.黄金, 0.1)],
      [DEFAULT_MACRO_SYMBOLS.原油]: [row(DEFAULT_MACRO_SYMBOLS.原油, 0.3)],
    });
    expect(r.label).toBe("risk_on");
  });

  it("取最新一条，不是第一条", () => {
    const s = DEFAULT_MACRO_SYMBOLS.A50;
    const r = run({ [s]: [row(s, -5), { ...row(s, 1), ts: "2026-08-03 07:00:00" }] });
    expect(r.value).toBeCloseTo(1, 6);
  });

  it("标的名可参数化 —— 采集器还没写，符号名未定", () => {
    const r = run({ "XIN9": [row("XIN9", 2)] }, { 标的: { A50: "XIN9" } });
    expect(r.value).toBeCloseTo(2, 6);
  });
});
