import { describe, it, expect } from "vitest";
import { parseLiftPage } from "@/lib/data/sources/eastmoney";

const ok = (data: any[], pages = 1) =>
  JSON.stringify({ success: true, code: 0, result: { pages, count: data.length, data } });

describe("parseLiftPage", () => {
  it("解析解禁记录，万股/万元换算成股/元 —— 单位不统一，下游一算比例就错两个数量级", () => {
    const r = parseLiftPage(ok([{
      SECURITY_CODE: "000785", FREE_DATE: "2026-09-22 00:00:00",
      CURRENT_FREE_SHARES: 1586.9448, LIFT_MARKET_CAP: 3665.842488,
      FREE_RATIO: 0.002569174855, TOTAL_RATIO: 0.002548470146,
      FREE_SHARES_TYPE: "定向增发机构配售股份",
    }]));
    expect(r.rows[0]).toEqual({
      code: "000785", freeDate: "2026-09-22",
      freeShares: 15869448, liftMktcap: 36658424.88,
      freeRatio: 0.002569174855, totalRatio: 0.002548470146,
      shareType: "定向增发机构配售股份",
    });
    expect(r.pages).toBe(1);
  });

  it("比例保持小数，**不**乘 100 —— 东财这两个字段给的就是小数，不是百分数", () => {
    const r = parseLiftPage(ok([{ SECURITY_CODE: "1", FREE_DATE: "2026-10-01", FREE_RATIO: 0.12 }]));
    expect(r.rows[0].freeRatio).toBe(0.12);
  });

  it("缺字段给 null，不给 0 —— 0 会被当成「这次解禁没压力」", () => {
    const r = parseLiftPage(ok([{ SECURITY_CODE: "1", FREE_DATE: "2026-10-01" }]));
    expect(r.rows[0].freeRatio).toBeNull();
    expect(r.rows[0].liftMktcap).toBeNull();
  });

  it("9201「返回数据为空」是合法的空结果 —— 那段日期确实没有解禁", () => {
    const r = parseLiftPage(JSON.stringify({ success: false, code: 9201, message: "返回数据为空", result: null }));
    expect(r.rows).toEqual([]);
  });

  it("其它失败码抛错 —— 9501 是报表名写错，9701 是报表下线，都不是「没有解禁」", () => {
    expect(() => parseLiftPage(JSON.stringify({ success: false, code: 9701, message: "服务器繁忙" })))
      .toThrow(/9701/);
  });

  it("不是 JSON 时抛错", () => {
    expect(() => parseLiftPage("<html>blocked</html>")).toThrow(/lift/i);
  });
});
