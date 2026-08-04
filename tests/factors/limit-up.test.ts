import { describe, it, expect } from "vitest";
import {
  wasSt, isFirstListingDay, limitUpThreshold,
  judgeBarLimitUp, judgeBarLimitDown, limitUpCodes, limitDownCodes, proxyLbc,
} from "@/lib/factors/limit-up";
import { makeView, bar, sealedBar, sec, weekdays } from "./view-double";

describe("wasSt —— ST 状态必须按日期回溯", () => {
  const s = sec("600129", "主板", {
    isStHistory: [{ from: "2022-05-06", to: "2023-04-20" }, { from: "2025-01-02", to: null }],
  });

  it("区间之前不是 ST", () => {
    expect(wasSt(s, "2022-05-05")).toBe(false);
  });
  it("区间内是 ST（闭区间，含起止日）", () => {
    expect(wasSt(s, "2022-05-06")).toBe(true);
    expect(wasSt(s, "2022-11-11")).toBe(true);
    expect(wasSt(s, "2023-04-20")).toBe(true);
  });
  it("摘帽之后不是 ST", () => {
    expect(wasSt(s, "2023-04-21")).toBe(false);
    expect(wasSt(s, "2024-12-31")).toBe(false);
  });
  it("to=null 表示至今仍 ST", () => {
    expect(wasSt(s, "2026-08-03")).toBe(true);
  });
  it("无 ST 历史的票永远不是 ST", () => {
    expect(wasSt(sec("600519", "主板"), "2022-06-01")).toBe(false);
  });
});

describe("limitUpThreshold —— 分板阈值（spec §8.1）", () => {
  it("各板阈值", () => {
    expect(limitUpThreshold(sec("600000", "主板"), "2026-08-03")).toBe(9.8);
    expect(limitUpThreshold(sec("300750", "创业板"), "2026-08-03")).toBe(19.8);
    expect(limitUpThreshold(sec("688111", "科创板"), "2026-08-03")).toBe(19.8);
    expect(limitUpThreshold(sec("832317", "北交所"), "2026-08-03")).toBe(29.7);
  });

  it("ST 优先于板块，且按当日 ST 状态判", () => {
    const s = sec("600129", "主板", { isStHistory: [{ from: "2022-05-06", to: "2023-04-20" }] });
    expect(limitUpThreshold(s, "2022-06-01")).toBe(4.8);
    expect(limitUpThreshold(s, "2026-08-03")).toBe(9.8);
  });
});

describe("judgeBarLimitUp —— 日线代理还原封板", () => {
  const prev = (code: string, c: number) => bar(code, "2026-07-31", c);

  it("主板 9.9% 且收盘==最高 → 涨停", () => {
    const s = sec("600000", "主板");
    const j = judgeBarLimitUp(s, sealedBar("600000", "2026-08-03", 10, 9.9), prev("600000", 10));
    expect(j.limitUp).toBe(true);
    expect(j.pct).toBeCloseTo(9.9, 4);
  });

  it("主板 9.9% 但收盘 < 最高（炸板）→ 不算涨停", () => {
    const s = sec("600000", "主板");
    const b = bar("600000", "2026-08-03", 10.99, { h: 11.0, l: 10.2 });
    expect(judgeBarLimitUp(s, b, prev("600000", 10)).limitUp).toBe(false);
  });

  it("主板 9.7% 未到阈值 → 不算涨停", () => {
    const s = sec("600000", "主板");
    expect(judgeBarLimitUp(s, sealedBar("600000", "2026-08-03", 10, 9.7), prev("600000", 10)).limitUp).toBe(false);
  });

  it("创业板 19.9% 涨停 / 19.5% 不涨停", () => {
    const s = sec("300750", "创业板");
    expect(judgeBarLimitUp(s, sealedBar("300750", "2026-08-03", 10, 19.9), prev("300750", 10)).limitUp).toBe(true);
    expect(judgeBarLimitUp(s, sealedBar("300750", "2026-08-03", 10, 19.5), prev("300750", 10)).limitUp).toBe(false);
  });

  it("创业板 10% 不算涨停 —— 用主板阈值会误判", () => {
    const s = sec("300750", "创业板");
    expect(judgeBarLimitUp(s, sealedBar("300750", "2026-08-03", 10, 10), prev("300750", 10)).limitUp).toBe(false);
  });

  it("科创板 19.85% 涨停", () => {
    const s = sec("688111", "科创板");
    expect(judgeBarLimitUp(s, sealedBar("688111", "2026-08-03", 20, 19.85), prev("688111", 20)).limitUp).toBe(true);
  });

  it("北交所 29.8% 涨停 / 29.5% 不涨停", () => {
    const s = sec("832317", "北交所");
    expect(judgeBarLimitUp(s, sealedBar("832317", "2026-08-03", 10, 29.8), prev("832317", 10)).limitUp).toBe(true);
    expect(judgeBarLimitUp(s, sealedBar("832317", "2026-08-03", 10, 29.5), prev("832317", 10)).limitUp).toBe(false);
  });

  it("2022 年是 ST 的票：用 2022 的日期判 4.9% = 涨停，用今天的状态判就漏了", () => {
    const s = sec("600129", "主板", { isStHistory: [{ from: "2022-05-06", to: "2023-04-20" }] });
    const past = judgeBarLimitUp(s, sealedBar("600129", "2022-06-01", 10, 4.9), bar("600129", "2022-05-31", 10));
    expect(past.limitUp).toBe(true);
    expect(past.threshold).toBe(4.8);

    const now = judgeBarLimitUp(s, sealedBar("600129", "2026-08-03", 10, 4.9), bar("600129", "2026-07-31", 10));
    expect(now.limitUp).toBe(false);
    expect(now.threshold).toBe(9.8);
  });

  it("上市首日排除 —— 涨 43% 也不计涨停", () => {
    const s = sec("301000", "创业板", { listDate: "2026-08-03" });
    const j = judgeBarLimitUp(s, sealedBar("301000", "2026-08-03", 10, 43), bar("301000", "2026-07-31", 10));
    expect(j.limitUp).toBe(false);
    expect(j.reason).toContain("上市首日");
  });

  it("无前收 → 不判涨停，pct 为 null（不是 0）", () => {
    const s = sec("600000", "主板");
    const j = judgeBarLimitUp(s, sealedBar("600000", "2026-08-03", 10, 9.9), null);
    expect(j.limitUp).toBe(false);
    expect(j.pct).toBeNull();
  });

  it("涨幅用复权后收盘算 —— 除权日不复权会算出假跌幅", () => {
    const s = sec("600000", "主板");
    const prevBar = bar("600000", "2026-07-31", 10, { adjFactor: 1.1 });   // 复权后 11
    const today = bar("600000", "2026-08-03", 12.1, { h: 12.1, adjFactor: 1 });
    const j = judgeBarLimitUp(s, today, prevBar);
    expect(j.pct).toBeCloseTo(10, 6);
    expect(j.limitUp).toBe(true);
  });
});

describe("judgeBarLimitDown —— 跌停（防守触发要数跌停家数）", () => {
  it("主板 -9.9% 且收盘==最低 → 跌停", () => {
    const s = sec("600000", "主板");
    const b = bar("600000", "2026-08-03", 9.01, { h: 9.6, l: 9.01 });
    expect(judgeBarLimitDown(s, b, bar("600000", "2026-07-31", 10)).limitDown).toBe(true);
  });
  it("ST -4.9% 跌停", () => {
    const s = sec("600129", "主板", { isStHistory: [{ from: "2026-01-01", to: null }] });
    const b = bar("600129", "2026-08-03", 9.51, { h: 9.9, l: 9.51 });
    expect(judgeBarLimitDown(s, b, bar("600129", "2026-07-31", 10)).limitDown).toBe(true);
  });
});

describe("limitUpCodes / limitDownCodes —— 全市场扫描", () => {
  const ds = ["2026-07-31", "2026-08-03"];
  const view = makeView({
    asOf: "2026-08-03",
    securities: [
      sec("600000", "主板"),
      sec("300750", "创业板"),
      sec("832317", "北交所"),
      sec("600129", "主板", { isStHistory: [{ from: "2026-01-01", to: null }] }),
      sec("301999", "创业板", { listDate: "2026-08-03" }),
      sec("600900", "主板"),
      sec("600001", "主板", { delistDate: "2026-01-01" }),   // 已退市，不该进池子
    ],
    bars: {
      "600000": [bar("600000", ds[0], 10), sealedBar("600000", ds[1], 10, 9.9)],
      "300750": [bar("300750", ds[0], 10), sealedBar("300750", ds[1], 10, 19.9)],
      "832317": [bar("832317", ds[0], 10), sealedBar("832317", ds[1], 10, 29.8)],
      "600129": [bar("600129", ds[0], 10), sealedBar("600129", ds[1], 10, 4.9)],
      "301999": [sealedBar("301999", ds[1], 10, 43)],
      "600900": [bar("600900", ds[0], 10), bar("600900", ds[1], 9.01, { h: 9.6, l: 9.01 })],
      "600001": [bar("600001", ds[0], 10)],
    },
  });

  it("四板各自阈值都命中，首日新股与退市票不进", () => {
    const { codes, unknown } = limitUpCodes(view, "2026-08-03");
    expect(codes.sort()).toEqual(["300750", "600000", "600129", "832317"]);
    expect(codes).not.toContain("301999");
    expect(unknown).toContain("301999");   // 只有一根，没前收 → 未知而非 0
  });

  it("跌停家数", () => {
    expect(limitDownCodes(view, "2026-08-03").codes).toEqual(["600900"]);
  });
});

describe("proxyLbc —— 连板高度的日线代理", () => {
  it("连续三个封板 → 3 板", () => {
    const ds = weekdays("2026-07-27", 5);
    const closes = [10, 11, 12.1, 13.31, 13.31];
    const bars = ds.map((d, i) => i === 0
      ? bar("600000", d, closes[i])
      : sealedBar("600000", d, closes[i - 1], (closes[i] / closes[i - 1] - 1) * 100));
    // 最后一根不是封板（收盘不等最高）
    bars[4] = bar("600000", ds[4], 13.5, { h: 14.0 });
    const view = makeView({
      asOf: ds[4], securities: [sec("600000", "主板")], bars: { "600000": bars },
    });
    expect(proxyLbc(view, "600000", ds[3])).toBe(3);
    expect(proxyLbc(view, "600000", ds[4])).toBe(0);
  });
});

describe("isFirstListingDay", () => {
  it("listDate 为 null 时不能断言是首日", () => {
    expect(isFirstListingDay(sec("600000", "主板", { listDate: null }), "2026-08-03")).toBe(false);
  });
});
