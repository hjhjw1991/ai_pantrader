/**
 * 情绪截面：一次全市场遍历算出晋级率、溢价、炸板、涨跌中位数。
 *
 * 用一个 9 只票、5 个交易日的小市场把每个口径钉死。每只票的剧本写在旁边，
 * 期望值都能手算出来 —— 这类统计最怕的是"分母悄悄换了"（把停牌票算进去、
 * 把首板和连板混在一起），而那种错只看结果数字是看不出来的。
 */
import { describe, it, expect } from "vitest";
import { sentimentSnapshot, percentileRank } from "@/lib/factors/sentiment";
import type { DailyBar } from "@/lib/contracts";
import { makeView, bar, sec, weekdays } from "./view-double";

const DAYS = weekdays("2026-09-14", 5);   // d0..d4，评估日 D = d4
const D = DAYS[4];
const r2 = (x: number) => Math.round(x * 100) / 100;

type Step = "zt" | "zb" | "dt" | number | null;
/** 从 10 元起按剧本走。null = 那天停牌（没有日线） */
function path(code: string, steps: Step[], open?: Record<number, number>): DailyBar[] {
  const out: DailyBar[] = [];
  let p = 10;
  out.push(bar(code, DAYS[0], p));
  for (let i = 1; i < DAYS.length; i++) {
    const s = steps[i - 1];
    if (s === null) continue;
    const lim = r2(p * 1.1);
    let b: DailyBar;
    if (s === "zt") b = bar(code, DAYS[i], lim, { h: lim, o: open?.[i] ?? p });
    else if (s === "zb") b = bar(code, DAYS[i], r2(p * 1.05), { h: lim, o: p });
    else if (s === "dt") { const c = r2(p * 0.9); b = bar(code, DAYS[i], c, { l: c, o: p, h: p }); }
    else { const c = r2(p * (1 + s / 100)); b = bar(code, DAYS[i], c, { o: open?.[i] ?? p }); }
    out.push(b);
    p = b.c;
  }
  return out;
}

//                         d1    d2    d3    d4
const SCRIPT: Record<string, Step[]> = {
  "600001": [0,    0,    "zt", "zt"],  // A 首板 → 晋级成功
  "600002": [0,    0,    "zt", 2],     // B 首板 → 晋级失败，溢价 +2
  "600003": [0,    "zt", "zt", "zt"],  // C 二板 → 三板，今日最高板 3
  "600004": ["zt", "zt", "zt", -5],    // D 三板（昨日最高）→ 断板 -5
  "600005": [0,    0,    "zb", -3],    // E 昨日炸板 → 今日 -3
  "600006": [0,    0,    0,    "zb"],  // F 今日炸板
  "600007": [0,    0,    0,    "dt"],  // G 今日跌停
  "600008": [0,    0,    0,    null],  // H 今日停牌
  "600009": [0,    0,    0,    1],     // I 普通 +1
};

function market() {
  const bars: Record<string, DailyBar[]> = {};
  for (const [code, s] of Object.entries(SCRIPT)) {
    // A 今天高开 5%：开盘溢价口径要能看出来
    bars[code] = path(code, s, code === "600001" ? { 4: 11.55 } : undefined);
  }
  return makeView({
    asOf: D, tradingDays: DAYS,
    securities: Object.keys(SCRIPT).map(c => sec(c, "主板")),
    bars,
  });
}

describe("sentimentSnapshot", () => {
  const s = sentimentSnapshot(market(), D);

  it("涨跌家数与中位数：停牌票进 unknown，不算平盘", () => {
    expect(s.up).toBe(5);
    expect(s.down).toBe(3);
    expect(s.unknown).toBe(1);
    // 当日涨幅 [10,2,10,-5,-3,5,-10,1] 排序后中间两个是 1 和 2
    expect(s.medianPct).toBeCloseTo(1.5, 1);
  });

  it("涨停 / 跌停 / 炸板家数；炸板率 = 炸板 / (涨停 + 炸板)", () => {
    expect(s.zt).toBe(2);
    expect(s.dt).toBe(1);
    expect(s.zb).toBe(1);
    expect(s.zbRate).toBeCloseTo(1 / 3, 6);
  });

  it("今日最高板与连板家数", () => {
    expect(s.maxLbc).toBe(3);
    expect(s.lbCount).toBe(2);
  });

  it("首板晋级率：分母只有昨日首板（A、B），不含连板", () => {
    expect(s.firstPrev).toBe(2);
    expect(s.firstPromo).toBeCloseTo(0.5, 9);
  });

  it("连板晋级率：分母是昨日 ≥2 板（C、D）", () => {
    expect(s.multiPrev).toBe(2);
    expect(s.multiPromo).toBeCloseTo(0.5, 9);
  });

  it("昨日涨停今日溢价（收盘口径）= A、B、C、D 今日涨幅均值", () => {
    expect(s.ztPrem).toBeCloseTo((10 + 2 + 10 - 5) / 4, 1);
  });

  it("三桶：首板溢价（A、B）、连板溢价（C、D）、炸板溢价（E）", () => {
    expect(s.firstPrem).toBeCloseTo(6, 1);
    expect(s.multiPrem).toBeCloseTo(2.5, 1);
    expect(s.zbPrem).toBeCloseTo(-3, 1);
  });

  it("高度板溢价：昨日最高板（D，3 板）今日的涨幅", () => {
    expect(s.highLbcPrev).toBe(3);
    expect(s.highPrem).toBeCloseTo(-5, 1);
  });

  it("开盘溢价：A 高开 5%，B/C/D 平开 → 均值 1.25", () => {
    expect(s.ztOpenPrem).toBeCloseTo(5 / 4, 1);
  });

  it("昨日没有涨停时，溢价与晋级率是 null 而不是 0 —— 0 会被读成「今天全体吃面」", () => {
    const quiet = makeView({
      asOf: D, tradingDays: DAYS, securities: [sec("600009", "主板")],
      bars: { "600009": path("600009", [0, 0, 0, 1]) },
    });
    const q = sentimentSnapshot(quiet, D);
    expect(q.ztPrem).toBeNull();
    expect(q.firstPromo).toBeNull();
    expect(q.multiPromo).toBeNull();
    expect(q.highPrem).toBeNull();
    expect(q.zbRate).toBeNull();
  });

  it("昨日最高只有首板时，高度板溢价为 null：一板不算高度", () => {
    const v = makeView({
      asOf: D, tradingDays: DAYS, securities: [sec("600002", "主板")],
      bars: { "600002": path("600002", [0, 0, "zt", 2]) },
    });
    expect(sentimentSnapshot(v, D).highPrem).toBeNull();
  });

  it("创业板 20cm 按 20% 判涨停，10% 的大阳不是涨停", () => {
    const code = "300001";
    const v = makeView({
      asOf: D, tradingDays: DAYS, securities: [sec(code, "创业板")],
      bars: { [code]: path(code, [0, 0, 0, "zt"]) },   // path 的 "zt" 是 +10%
    });
    expect(sentimentSnapshot(v, D).zt).toBe(0);
  });
});

describe("ST 不进涨停类统计", () => {
  it("ST 涨停只进涨跌家数，不进涨停家数与晋级", () => {
    const st = { isStHistory: [{ from: "2026-01-01", to: null }] };
    const v = makeView({
      asOf: D, tradingDays: DAYS,
      securities: [sec("600001", "主板", st), sec("600009", "主板")],
      bars: { "600001": path("600001", [0, 0, "zt", "zt"]), "600009": path("600009", [0, 0, 0, 1]) },
    });
    const s = sentimentSnapshot(v, D);
    expect(s.up).toBe(2);
    expect(s.zt).toBe(0);
    expect(s.firstPrev).toBe(0);
  });
});

describe("percentileRank", () => {
  it("严格小于的占比 + 并列的一半", () => {
    expect(percentileRank([1, 2, 3, 4], 3)).toBeCloseTo(0.625, 9);
    expect(percentileRank([1, 2, 3, 4], 0)).toBe(0);
    expect(percentileRank([1, 2, 3, 4], 5)).toBe(1);
  });
  it("空样本 → null；null 值被忽略", () => {
    expect(percentileRank([], 1)).toBeNull();
    expect(percentileRank([null, 1, null, 3], 2)).toBeCloseTo(0.5, 9);
  });
});
