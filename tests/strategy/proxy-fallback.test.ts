/**
 * 代理截面回退：那天没有真涨停池 / 板块榜时，主线识别与候选池改读日线重建的代理截面，
 * 并且在结果上说出来；有真快照时代理一眼都不看。
 */
import { describe, it, expect } from "vitest";
import { identifyMainlines } from "@/lib/factors/sectors";
import { candidatePool } from "@/lib/strategy/engine";
import { makeView, config, zt, series, sec } from "./helpers";

const DAYS = ["2026-07-28", "2026-07-29", "2026-07-30", "2026-07-31", "2026-08-03"];
const D = "2026-08-03";
const proxyZt = { [D]: [{ date: D, code: "688001", lbc: 2, sector: "集成电路制造" }] };
const proxySec = { [D]: [
  { date: D, sector: "集成电路制造", pct: 4, leaderCode: "688002", members: 30 },
  { date: D, sector: "国有大型银行Ⅲ", pct: -1, leaderCode: "601398", members: 6 },
] };

const view = (over: Record<string, unknown> = {}) => makeView({
  asOf: `${D} 15:05:00`, tradingDays: DAYS,
  securities: [sec("688001", "科创板"), sec("688002", "科创板")],
  bars: { "688001": series("688001", DAYS, [10, 10, 10, 12, 14.4]), "688002": series("688002", DAYS, [10, 10, 10, 10.2, 10.6]) },
  industries: { "688001|3": { indexCode: "850811", indexName: "集成电路制造" }, "688002|3": { indexCode: "850811", indexName: "集成电路制造" } },
  ztProxy: proxyZt, sectorProxy: proxySec, ...over,
});

describe("主线识别的代理回退", () => {
  it("没有真快照 → 用代理行业榜与代理涨停名单，并标 proxy", () => {
    const r = identifyMainlines(view(), D, { 板块涨幅榜TopN: 1 });
    expect(r.sectorProxy).toBe(true);
    expect(r.ztProxy).toBe(true);
    expect(r.mainlines[0]).toMatchObject({ name: "集成电路制造", source: "板块榜", limitUpCount: 1, maxLbc: 2 });
  });

  it("有真快照 → 代理一眼都不看", () => {
    const r = identifyMainlines(view({
      zt: { [D]: [zt(D, "600183", { sector: "半导体", lbc: 3, sealAmt: 2e8 })] },
      sectors: { [D]: [{ date: D, ts: `${D} 15:00:00`, sector: "半导体", pct: 5, leaderCode: "600183" }] },
    }), D, { 板块涨幅榜TopN: 1 });
    expect(r.sectorProxy).toBe(false);
    expect(r.ztProxy).toBe(false);
    expect(r.mainlines[0].name).toBe("半导体");
  });
});

describe("候选池的代理回退", () => {
  it("涨停池与主线领涨两路都能从代理里出票；卡片上告警用了代理", () => {
    const warns: string[] = [];
    const pool = candidatePool({ view: view(), config: config(), phase: "盘后", positions: [] }, ["集成电路制造"], D, m => warns.push(m));
    expect(pool.map(r => [r.code, r.source])).toEqual(expect.arrayContaining([["688001", "涨停池"], ["688002", "主线领涨"]]));
    // 代理行没有封单额，进池子按 0 排，不能是 NaN
    expect(pool.every(r => Number.isFinite(r.sealAmt))).toBe(true);
    expect(warns.some(w => w.includes("代理截面"))).toBe(true);
  });

  it("代理日的量价一路改用申万历史归属：没有传行业映射也不会整路关掉", () => {
    const warns: string[] = [];
    candidatePool({ view: view(), config: config(), phase: "盘后", positions: [] }, ["集成电路制造"], D, m => warns.push(m));
    expect(warns.some(w => w.includes("量价 未启用"))).toBe(false);
  });
});
