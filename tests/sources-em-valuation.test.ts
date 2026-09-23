import { describe, it, expect } from "vitest";
import { parseValuationPage } from "@/lib/data/sources/eastmoney";

const page = (diff: any[], total = 5919) =>
  JSON.stringify({ rc: 0, data: { total, diff } });

describe("parseValuationPage", () => {
  it("解析 PE/PB/市值", () => {
    const rows = parseValuationPage(page([
      { f12: "000001", f9: 4.38, f23: 0.49, f20: 224914591915, f21: 224911889046 },
    ]));
    expect(rows.rows).toEqual([
      { code: "000001", pe: 4.38, pb: 0.49, mktcap: 224914591915, floatMktcap: 224911889046 },
    ]);
    expect(rows.total).toBe(5919);
  });

  it('东财用 "-" 表示没有值，必须变成 null 而不是 0', () => {
    const rows = parseValuationPage(page([
      { f12: "000003", f9: "-", f23: "-", f20: "-", f21: "-" },
    ]));
    expect(rows.rows[0]).toEqual({
      code: "000003", pe: null, pb: null, mktcap: null, floatMktcap: null,
    });
  });

  it("亏损股的负 PE 如实保留 —— 它不是缺数据，更不是「便宜」", () => {
    const rows = parseValuationPage(page([{ f12: "000002", f9: -1.64, f23: 0.48 }]));
    expect(rows.rows[0].pe).toBe(-1.64);
  });

  it("空页返回空数组，不抛错 —— 分页到底就是这样结束的", () => {
    expect(parseValuationPage(page([])).rows).toEqual([]);
  });

  it("payload 不是合法 JSON 时抛错，不能当成「今天没有估值数据」", () => {
    expect(() => parseValuationPage("<html>blocked</html>")).toThrow(/valuation/i);
  });

  it("diff 不是数组时抛错 —— 限流经常表现成结构不对，不是空列表", () => {
    expect(() => parseValuationPage(JSON.stringify({ data: { diff: null } }))).toThrow(/valuation/i);
  });
});
