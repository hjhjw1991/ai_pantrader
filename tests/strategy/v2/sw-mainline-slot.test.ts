import { describe, it, expect } from "vitest";
import { 主线识别器_申万聚集 } from "@/lib/strategy/v2/slots/sw-mainline";

function ctx(f: any, calls: Array<[string, any]> = [], warns: string[] = []) {
  return {
    runFactor: (name: string, extra: any) => {
      calls.push([name, extra]);
      if (name === "申万主线") return f;
      if (name === "龙头温度计") return { name, version: "1", value: 2, label: "封板", provenance: "real", confidence: 0.85 };
      return null;
    },
    warn: (m: string) => { warns.push(m); },
  } as any;
}

describe("主线识别器_申万聚集", () => {
  it("名单 = 行业名 ∪ 成员实际出现过的板块名；龙头温度计按第一条主线龙头的原板块名找", () => {
    const calls: Array<[string, any]> = [];
    const r = 主线识别器_申万聚集.detect(ctx({
      name: "申万主线", version: "1.0.0", value: ["电子", "传媒"], label: "电子(3) / 传媒(1，4板)", provenance: "real", confidence: 0.85,
      inputs: { 明细: [{ name: "电子", sectors: ["半导体", "集成电路制造"], leaderSector: "半导体" }, { name: "传媒", sectors: ["出版"], leaderSector: "出版" }] },
    }, calls), {});
    expect(r.names).toEqual(["电子", "传媒", "半导体", "集成电路制造", "出版"]);
    expect(calls.find(c => c[0] === "龙头温度计")![1]).toEqual({ 板块: "半导体" });
    expect(r.factors.map(f => f.name)).toEqual(["申万主线", "龙头温度计"]);
  });

  it("没有主线：名单为空并上卡告警，不猜", () => {
    const warns: string[] = [];
    const r = 主线识别器_申万聚集.detect(ctx({ name: "申万主线", version: "1.0.0", value: [], label: "没有涨停扎堆的行业", provenance: "real", confidence: 0.85, inputs: { 明细: [] } }, [], warns), {});
    expect(r.names).toEqual([]);
    expect(warns[0]).toMatch(/没有涨停扎堆的行业/);
  });
});
