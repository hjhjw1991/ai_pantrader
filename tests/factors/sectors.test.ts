import { describe, it, expect } from "vitest";
import {
  必查链, 必查链关键词, chainOf, identifyMainlines, SECTOR_FACTORS,
} from "@/lib/factors/sectors";
import type { SectorRankRow } from "@/lib/contracts";
import { makeView, ztRow, sec, bar, sealedBar } from "./view-double";

const D = "2026-07-27";

const rank = (sector: string, pct: number): SectorRankRow =>
  ({ date: D, ts: `${D} 15:00:00`, sector, pct, leaderCode: null });

describe("必查链是写死的", () => {
  it("四条链齐全", () => {
    expect([...必查链]).toEqual(["半导体全链", "军工", "电网", "资源"]);
  });

  it("每条链都有关键词，否则匹配不到板块名", () => {
    for (const c of 必查链) expect(必查链关键词[c].length).toBeGreaterThan(0);
  });

  it("chainOf 把板块名归到链上", () => {
    expect(chainOf("半导体")).toBe("半导体全链");
    expect(chainOf("覆铜板")).toBe("半导体全链");
    expect(chainOf("船舶制造")).toBe("军工");
    expect(chainOf("电网设备")).toBe("电网");
    expect(chainOf("小金属")).toBeNull();
    expect(chainOf("稀土永磁")).toBe("资源");
    expect(chainOf(null)).toBeNull();
  });
});

describe("identifyMainlines —— 2026-07-27 主线级漏扫的根因回归测试", () => {
  // 板块榜上前三是白酒/银行/地产，半导体均值只排第 9，
  // 但链内有一只 3 板龙头封板 —— 按均值排名会整条链漏掉。
  const view = makeView({
    asOf: D,
    sectors: {
      [D]: [
        rank("白酒", 4.2), rank("银行", 3.1), rank("房地产", 2.8),
        rank("半导体", 0.4), rank("军工", -0.3),
      ],
    },
    zt: {
      [D]: [
        ztRow(D, "600183", { sector: "覆铜板", lbc: 3, sealAmt: 5e8 }),
        ztRow(D, "600519", { sector: "白酒", lbc: 1 }),
        // 银行 / 房地产 也要真有涨停才配当主线（新判据：0 涨停不进主线）
        ztRow(D, "601398", { sector: "银行", lbc: 1 }),
        ztRow(D, "600048", { sector: "房地产", lbc: 1 }),
      ],
    },
  });

  it("均值排名靠后的必查链，只要链内有龙头封板就必须进主线", () => {
    const r = identifyMainlines(view, D, { 板块涨幅榜TopN: 3 });
    const names = r.mainlines.map(m => m.name);
    expect(names).toContain("半导体全链");
    const hit = r.mainlines.find(m => m.name === "半导体全链")!;
    expect(hit.source).toBe("必查链龙头");
    expect(hit.leaderCode).toBe("600183");
    expect(hit.limitUpCount).toBe(1);
    expect(hit.maxLbc).toBe(3);
  });

  it("板块涨幅榜 TopN 照常进", () => {
    const names = identifyMainlines(view, D, { 板块涨幅榜TopN: 3 }).mainlines.map(m => m.name);
    expect(names.slice(0, 3)).toEqual(["白酒", "银行", "房地产"]);
  });

  it("必查链不是可关闭参数：传空数组也照扫四条链", () => {
    const r = identifyMainlines(view, D, { 板块涨幅榜TopN: 3, 必查链: [] });
    expect(r.扫描的链).toEqual([...必查链]);
    expect(r.mainlines.map(m => m.name)).toContain("半导体全链");
  });

  it("配置里额外加的链只能叠加，不能替换掉写死的四条", () => {
    const r = identifyMainlines(view, D, { 板块涨幅榜TopN: 3, 必查链: ["光伏"] });
    expect(r.扫描的链).toEqual([...必查链, "光伏"]);
  });

  it("链内没有涨停就不硬塞进主线", () => {
    const v = makeView({
      asOf: D,
      sectors: { [D]: [rank("白酒", 4.2), rank("半导体", 0.4)] },
      zt: { [D]: [ztRow(D, "600519", { sector: "白酒" })] },
    });
    const names = identifyMainlines(v, D, { 板块涨幅榜TopN: 1 }).mainlines.map(m => m.name);
    expect(names).not.toContain("半导体全链");
  });

  it("同一板块多个时点快照只取最后一条", () => {
    const v = makeView({
      asOf: D,
      sectors: {
        [D]: [
          { date: D, ts: `${D} 10:00:00`, sector: "白酒", pct: 1, leaderCode: null },
          { date: D, ts: `${D} 15:00:00`, sector: "白酒", pct: 4, leaderCode: null },
          rank("银行", 2),
        ],
      },
      zt: { [D]: [ztRow(D, "600519", { sector: "白酒", lbc: 1 })] },
    });
    const r = identifyMainlines(v, D, { 板块涨幅榜TopN: 2 });
    expect(r.mainlines[0].name).toBe("白酒");
    expect(r.mainlines[0].pct).toBe(4);
  });

  /* ---------------- 2026-10-06 九月主线核查的回归测试 ---------------- */

  /**
   * 背景：只看板块均值涨幅时，9 月 21 个交易日里有 **11 天**板块榜给出的三条主线
   * 一只涨停都没有。最刺眼的是 09-21：医药生物当天 21 家涨停全场第一，
   * 板块榜给的却是"其他医疗服务"（0 家），而真正的最大一块化学制药 9 家没进名单。
   * 这类伪主线的危害是静默的 —— 按主线选票时这些板块里根本没有票可挑。
   */
  it("0 涨停的板块不算主线：涨幅第一但没有一只封板要被筛掉", () => {
    const v = makeView({
      asOf: D,
      sectors: { [D]: [rank("白酒", 4.2), rank("化工", 3.9), rank("房地产", 2.8)] },
      zt: { [D]: [] },
    });
    const r = identifyMainlines(v, D, { 板块涨幅榜TopN: 3 });
    expect(r.mainlines.filter(m => m.source === "板块榜")).toEqual([]);
    expect(r.板块榜候选).toBe(3);
    expect(r.板块榜筛掉).toBe(3);
  });

  it("筛掉的名额要给真有涨停的板块：涨幅略低但有 9 家封板的应该补上来", () => {
    const v = makeView({
      asOf: D,
      sectors: { [D]: [rank("医疗服务", 5.0), rank("化学制药", 3.1), rank("房产服务", 2.9)] },
      zt: {
        [D]: [
          ztRow(D, "600276", { sector: "化学制药", lbc: 1 }),
          ztRow(D, "600196", { sector: "化学制药", lbc: 2 }),
        ],
      },
    });
    const names = identifyMainlines(v, D, { 板块涨幅榜TopN: 3 }).mainlines
      .filter(m => m.source === "板块榜").map(m => m.name);
    // 医疗服务均值涨幅第一但 0 涨停 → 出局；化学制药 2 家涨停顶上来
    expect(names).toEqual(["化学制药"]);
  });

  /**
   * 上一条 TopN = 3、板块也只有 3 个，"先筛后截"与"先截后筛"结果一样，顺序其实没被测到。
   * 这里 TopN = 2 < 5 个板块，且排第 1、第 3 的都是 0 涨停：
   *   先筛后截 → [白酒, 化学制药]（被筛掉的名额让给第 4 名）
   *   先截后筛 → [白酒]（第 1 名占了名额又被筛掉，名额白丢）
   */
  it("先按涨停家数过滤、再截 TopN：高排名的 0 涨停板块不占名额", () => {
    const v = makeView({
      asOf: D,
      sectors: {
        [D]: [
          rank("医疗服务", 5.0), rank("白酒", 4.0), rank("房产服务", 3.0),
          rank("化学制药", 2.0), rank("旅游", 1.0),
        ],
      },
      zt: {
        [D]: [
          ztRow(D, "600519", { sector: "白酒", lbc: 1 }),
          ztRow(D, "600276", { sector: "化学制药", lbc: 1 }),
          ztRow(D, "600196", { sector: "化学制药", lbc: 2 }),
          ztRow(D, "600138", { sector: "旅游", lbc: 1 }),
        ],
      },
    });
    const r = identifyMainlines(v, D, { 板块涨幅榜TopN: 2 });
    expect(r.mainlines.filter(m => m.source === "板块榜").map(m => m.name)).toEqual(["白酒", "化学制药"]);
    expect(r.板块榜候选).toBe(5);
    expect(r.板块榜筛掉).toBe(2);
  });

  it("板块涨停下限=0 可恢复旧行为（涨幅榜照进，不做家数过滤）", () => {
    const names = identifyMainlines(view, D, { 板块涨幅榜TopN: 2, 板块涨停下限: 0 })
      .mainlines.filter(m => m.source === "板块榜").map(m => m.name);
    expect(names).toEqual(["白酒", "银行"]);
  });
});

describe("主线识别因子", () => {
  const spec = SECTOR_FACTORS.find(f => f.name === "主线识别")!;

  it("value 是主线名列表", () => {
    const view = makeView({
      asOf: D,
      sectors: { [D]: [rank("白酒", 4.2)] },
      zt: { [D]: [ztRow(D, "600183", { sector: "PCB", lbc: 2 }), ztRow(D, "600519", { sector: "白酒", lbc: 1 })] },
    });
    const r = spec.fn({ view, params: { ...spec.defaults } }) as { value: string[] };
    expect(r.value).toContain("白酒");
    expect(r.value).toContain("半导体全链");
  });

  it("没有板块榜快照时置信度降下来（板块榜不可回补）", () => {
    const view = makeView({ asOf: D, zt: { [D]: [ztRow(D, "600183", { sector: "PCB" })] } });
    const r = spec.fn({ view, params: { ...spec.defaults } });
    expect(r.confidence).toBeLessThan(0.6);
  });
});

describe("龙头温度计 —— 影子票靠它定方向", () => {
  const spec = SECTOR_FACTORS.find(f => f.name === "龙头温度计")!;
  const run = (view: ReturnType<typeof makeView>, params: Record<string, unknown> = {}) =>
    spec.fn({ view, params: { ...spec.defaults, ...params } });

  it("龙头封板 → 主线活", () => {
    const view = makeView({
      asOf: D,
      zt: { [D]: [ztRow(D, "688146", { sector: "半导体", lbc: 2, openTimes: 0 })] },
      securities: [sec("688146", "科创板")],
      bars: { "688146": [bar("688146", "2026-07-24", 10), sealedBar("688146", D, 10, 19.9)] },
    });
    const r = run(view, { 板块: "半导体" });
    expect(r.value).toBe(2);
    expect(r.label).toBe("封板");
    expect(r.inputs?.["龙头"]).toBe("688146");
  });

  it("龙头炸板 → 分歧", () => {
    const view = makeView({
      asOf: D,
      zt: { [D]: [ztRow(D, "688146", { sector: "半导体", lbc: 1, openTimes: 3 })] },
      securities: [sec("688146", "科创板")],
      bars: { "688146": [bar("688146", "2026-07-24", 10), bar("688146", D, 11.5, { h: 12 })] },
    });
    const r = run(view, { 板块: "半导体" });
    expect(r.label).toBe("分歧");
    expect(r.value).toBe(1);
  });

  it("板块内无涨停 → 置信 0，不猜", () => {
    const r = run(makeView({ asOf: D }), { 板块: "半导体" });
    expect(r.confidence).toBe(0);
  });
});
