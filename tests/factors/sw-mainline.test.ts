import { describe, it, expect } from "vitest";
import type { ZtRow } from "@/lib/contracts";
import { swClusters } from "@/lib/factors/sw-mainline";

const z = (code: string, lbc: number, sector: string | null, sealAmt = 1e7): ZtRow =>
  ({ date: "2026-09-23", code, lbc, sector, sealAmt, openTimes: 0, firstSealTs: null, lastSealTs: null });

const L1: Record<string, [string, string]> = {
  "000001": ["801080", "电子"], "000002": ["801080", "电子"], "000003": ["801080", "电子"],
  "000004": ["801890", "机械设备"], "000005": ["801890", "机械设备"],
  "000006": ["801760", "传媒"],
};
const L3: Record<string, string> = { "000001": "集成电路制造", "000002": "半导体设备", "000003": "元件", "000006": "出版" };
const l1Of = (c: string) => (L1[c] ? { indexCode: L1[c][0], indexName: L1[c][1] } : null);
const l3Of = (c: string) => L3[c] ?? null;
const members = new Map([["801080", 30], ["801890", 20], ["801760", 10]]);

describe("swClusters", () => {
  const zt = [z("000001", 2, "半导体"), z("000002", 1, "半导体"), z("000003", 1, "元件"),
    z("000004", 1, "通用设备"), z("000005", 1, "通用设备"), z("000006", 4, "出版"), z("999999", 1, "未知")];

  it("涨停扎堆的一级行业是主线，名单里带上成员的申万三级与涨停池原名", () => {
    const r = swClusters(zt, l1Of, l3Of, members, { minZt: 3, topN: 3, heightMin: 3 });
    expect(r.clusters[0]).toMatchObject({ name: "电子", limitUpCount: 3, maxLbc: 2, leaderCode: "000001", leaderSector: "半导体", ratio: 0.1, source: "聚集" });
    expect(r.clusters[0].sectors).toEqual(["元件", "半导体", "半导体设备", "集成电路制造"]);
    expect(r.unmapped).toBe(1);
  });

  it("家数不够但有高度龙头（≥高度门槛）的行业也算主线 —— 不靠名单防漏扫", () => {
    const r = swClusters(zt, l1Of, l3Of, members, { minZt: 3, topN: 3, heightMin: 3 });
    expect(r.clusters.map(c => [c.name, c.source])).toEqual([["电子", "聚集"], ["传媒", "高度"]]);
  });

  it("家数不够、也没有高度龙头的不算；阈值放宽后按家数、连板、占比排序", () => {
    expect(swClusters(zt, l1Of, l3Of, members, { minZt: 3, topN: 3, heightMin: 5 }).clusters.map(c => c.name)).toEqual(["电子"]);
    expect(swClusters(zt, l1Of, l3Of, members, { minZt: 1, topN: 2, heightMin: 9 }).clusters.map(c => c.name)).toEqual(["电子", "机械设备"]);
  });

  it("没有行业归属的涨停股不硬塞进任何行业", () => {
    expect(swClusters([z("999999", 5, "x")], l1Of, l3Of, members, { minZt: 1, topN: 3, heightMin: 3 })).toEqual({ clusters: [], unmapped: 1 });
  });
});
