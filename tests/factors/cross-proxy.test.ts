import { describe, it, expect } from "vitest";
import { crossSectionProxy, ztRowsFor, crossRowsFor, CROSS_PROXY_MIN_MEMBERS } from "@/lib/factors/cross-proxy";
import type { DailyBar } from "@/lib/contracts";
import { makeView, bar, sec, weekdays, sealedBar } from "./view-double";

const DAYS = weekdays("2026-06-01", 4);
const D = DAYS[3];

/** 半导体 6 只：A 两连板、B 首板、其余平；银行 5 只普跌；另有 1 只 ST 涨停 */
function market() {
  const bars: Record<string, DailyBar[]> = {};
  const inds: Array<{ code: string; indexCode: string; indexName: string }> = [];
  const flat = (code: string, closes: number[]) => closes.map((c, i) => bar(code, DAYS[i], c));
  const semi = ["688001", "688002", "688003", "688004", "688005", "688006"];
  bars["688001"] = [bar("688001", DAYS[0], 10), bar("688001", DAYS[1], 10), sealedBar("688001", DAYS[2], 10, 20), sealedBar("688001", DAYS[3], 12, 20)];
  bars["688002"] = [...flat("688002", [10, 10, 10]), sealedBar("688002", DAYS[3], 10, 20)];
  for (const c of semi.slice(2)) bars[c] = flat(c, [10, 10, 10, 10.1]);
  const bank = ["601001", "601002", "601003", "601004", "601005"];
  for (const c of bank) bars[c] = flat(c, [10, 10, 10, 9.9]);
  bars["600999"] = [...flat("600999", [10, 10, 10]), sealedBar("600999", DAYS[3], 10, 10)];
  for (const c of semi) inds.push({ code: c, indexCode: "850811", indexName: "集成电路制造" });
  for (const c of bank) inds.push({ code: c, indexCode: "857421", indexName: "国有大型银行Ⅲ" });
  inds.push({ code: "600999", indexCode: "850811", indexName: "集成电路制造" });
  return makeView({
    asOf: D, tradingDays: DAYS,
    securities: [
      ...semi.map(c => sec(c, "科创板")), ...bank.map(c => sec(c, "主板")),
      sec("600999", "主板", { isStHistory: [{ from: "2026-01-01", to: null }] }),
    ],
    bars, industries1: [], ...({ industries3: inds } as any),
  });
}

describe("crossSectionProxy", () => {
  const p = crossSectionProxy(market(), D);

  it("涨停名单带连板数与申万三级行业，ST 不进", () => {
    expect(p.zt.map(z => [z.code, z.lbc, z.sector])).toEqual([
      ["688001", 2, "集成电路制造"], ["688002", 1, "集成电路制造"],
    ]);
  });

  it("行业涨幅 = 成分股等权平均；领涨 = 涨幅最大的非 ST", () => {
    const semi = p.sectors.find(s => s.sector === "集成电路制造")!;
    // 688001 +20、688002 +20、其余 4 只 +1、ST +10 → (20+20+4×1+10)/7
    expect(semi.pct).toBeCloseTo((20 + 20 + 4 + 10) / 7, 1);
    expect(semi.members).toBe(7);
    expect(["688001", "688002"]).toContain(semi.leaderCode);
    expect(p.sectors.find(s => s.sector === "国有大型银行Ⅲ")!.pct).toBeCloseTo(-1, 1);
  });

  it(`成分股少于 ${CROSS_PROXY_MIN_MEMBERS} 只的行业不上榜 —— 两三只票的行业靠噪声就能冲到榜首`, () => {
    expect(p.sectors.every(s => s.members >= CROSS_PROXY_MIN_MEMBERS)).toBe(true);
  });
});

describe("真快照优先，没有才退回代理", () => {
  const zt = [{ date: D, code: "000001", lbc: 1, sealAmt: 1e8, openTimes: 0, firstSealTs: null, lastSealTs: null, sector: "银行" }];
  const proxy = { [D]: [{ date: D, code: "688001", lbc: 2, sector: "集成电路制造" }] };

  const realSec = { [D]: [{ date: D, ts: `${D} 15:00:00`, sector: "银行", pct: 1, leaderCode: "000001" }] };
  const pSec = { [D]: [{ date: D, sector: "集成电路制造", pct: 3, leaderCode: "688001", members: 7 }] };
  const inds3 = [{ code: "000001", indexCode: "857421", indexName: "股份制银行Ⅲ" }];

  it("真涨停池与真板块榜都有 → 都用真的", () => {
    const r = crossRowsFor(makeView({ asOf: D, zt: { [D]: zt }, sectors: realSec, ztProxy: proxy, sectorProxy: pSec }), D);
    expect(r).toMatchObject({ ztProxy: false, sectorProxy: false, swNames: false });
    expect(r.zt.map(x => x.code)).toEqual(["000001"]);
  });

  it("只有真涨停池 → 涨停池留真的（封单额不丢）但板块名换成申万，板块榜用代理：两边名字必须同一套", () => {
    const r = crossRowsFor(makeView({ asOf: D, zt: { [D]: zt }, ztProxy: proxy, sectorProxy: pSec, ...({ industries3: inds3 } as any) }), D);
    expect(r).toMatchObject({ ztProxy: false, sectorProxy: true, swNames: true });
    expect(r.zt[0]).toMatchObject({ code: "000001", sector: "股份制银行Ⅲ", sealAmt: 1e8 });
    expect(r.sectors[0]).toMatchObject({ sector: "集成电路制造", ts: `${D} 15:00:00` });
  });

  it("混合日映射不到申万的涨停股 sector 置 null，不留东财名", () => {
    const zt2 = [...zt, { ...zt[0], code: "000002", sector: "银行" }];
    const r = crossRowsFor(makeView({ asOf: D, zt: { [D]: zt2 }, ztProxy: proxy, sectorProxy: pSec, ...({ industries3: inds3 } as any) }), D);
    expect(r.zt.find(z => z.code === "000002")!.sector).toBeNull();
  });

  it("只有真板块榜 → 两样都换代理（东财板块名映射不到申万）", () => {
    const r = crossRowsFor(makeView({ asOf: D, sectors: realSec, ztProxy: proxy, sectorProxy: pSec }), D);
    expect(r).toMatchObject({ ztProxy: true, sectorProxy: true, swNames: true });
    expect(r.sectors[0].sector).toBe("集成电路制造");
  });

  it("都没有真快照 → 用代理；封单额 / 开板次数是 NaN（不知道），不是 0", () => {
    const r = ztRowsFor(makeView({ asOf: D, ztProxy: proxy }), D);
    expect(r.proxy).toBe(true);
    expect(r.rows[0]).toMatchObject({ code: "688001", lbc: 2, sector: "集成电路制造" });
    expect(Number.isNaN(r.rows[0].sealAmt)).toBe(true);
    expect(Number.isNaN(r.rows[0].openTimes)).toBe(true);
  });

  it("代理也没有 → 有什么给什么，不标代理", () => {
    const r = crossRowsFor(makeView({ asOf: D, zt: { [D]: zt } }), D);
    expect(r).toMatchObject({ ztProxy: false, sectorProxy: false });
    expect(r.zt).toHaveLength(1);
  });
});
