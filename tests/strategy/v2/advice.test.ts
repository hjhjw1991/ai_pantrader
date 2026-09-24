import { describe, it, expect } from "vitest";
import type { FactorResult } from "@/lib/contracts";
import { techContext, holdingLean } from "@/lib/strategy/v2/advice";
import { createV2Engine, createSlotRegistry, BASELINE_SLOTS } from "@/lib/strategy/v2";
import { makeView, stubRegistry, config, series, sec, zt, quote, type StubValue } from "../helpers";

const f = (name: string, label: string, inputs: Record<string, unknown> = {}, confidence = 1): FactorResult<any> =>
  ({ name, version: "1.0.0", value: 0, label, provenance: "real", confidence, inputs });

describe("techContext / holdingLean", () => {
  it("M 顶确认 → 持仓考虑减仓，观察不宜买", () => {
    const fs = { pattern: f("M顶W底", "M顶确认", { 颈线: 9.5 }) };
    const h = techContext(fs, true), w = techContext(fs, false);
    expect(h.hints[0]).toEqual({ tone: "负面", text: "M 顶已跌破颈线 9.50，考虑减仓" });
    expect(w.hints[0].text).toMatch(/不宜买/);
    expect(holdingLean(h)).toBe("考虑减仓");
  });

  it("日周同时死叉 → 考虑减仓；只有一个负面 → 留意；没有 → 持有", () => {
    expect(holdingLean(techContext({ daily: f("日线MACD", "死叉"), weekly: f("周线MACD", "死叉") }, true))).toBe("考虑减仓");
    expect(holdingLean(techContext({ daily: f("日线MACD", "死叉"), weekly: f("周线MACD", "多头") }, true))).toBe("留意");
    expect(holdingLean(techContext({ daily: f("日线MACD", "金叉"), weekly: f("周线MACD", "多头") }, true))).toBe("持有");
  });

  it("离阻力不到 1 个 ATR：持仓提示分批止盈，观察提示上方空间小", () => {
    const fs = { structure: f("结构位", "盈亏比 0.5", { 现价: 10, 阻力: 10.4, 支撑: 9 }), atr: f("ATR", "x", { ATR: 0.5 }) };
    expect(techContext(fs, true).hints.map(h => h.text)).toContain("接近前高阻力 10.40，可考虑分批止盈");
    expect(techContext(fs, false).hints[0]).toMatchObject({ tone: "负面" });
  });

  it("confidence 0 的因子（没数据）不出提示", () => {
    const t = techContext({ pattern: f("M顶W底", "M顶确认", {}, 0), daily: f("日线MACD", "死叉", {}, 0) }, true);
    expect(t).toMatchObject({ daily: null, pattern: null, hints: [] });
  });
});

const DAYS = ["2026-07-28", "2026-07-29", "2026-07-30", "2026-07-31", "2026-08-03"];
const D = "2026-08-03";
const stubs: Record<string, StubValue> = {
  跌停家数: { value: 5, confidence: 0.9 }, 涨停家数: { value: 60, confidence: 0.9 },
  盘面强度: { value: 80, label: "强", confidence: 0.9 }, 情绪温度: { value: 65, confidence: 0.9 },
  赚钱效应: { value: 1.5, confidence: 0.9 }, 连板高度: { value: 4, confidence: 0.9 }, 炸板率: { value: 0.1, confidence: 0.95 },
  外围传导: { value: 0.4, label: "中性", confidence: 0.8 },
  主线识别: { value: ["半导体全链"], label: "半导体全链", confidence: 0.85,
    inputs: { 明细: [{ name: "半导体全链", leaderCode: "600183", maxLbc: 3, sectors: ["半导体"] }] } },
  龙头温度计: { value: 2, label: "封板", confidence: 0.85 },
  过滤器: (p: any) => p.code === "600999"
    ? { value: 1, confidence: 0.9, inputs: { 通过: [], 否决: ["超买"], 未判定: [] } }
    : { value: 0, confidence: 0.9, inputs: { 通过: ["位置"], 否决: [], 未判定: [] } },
  均线方向: { value: 1, label: "多头", confidence: 0.9 }, 量能: { value: 1.4, label: "放量", confidence: 0.9 },
  "洗盘vs派发": { value: 1, label: "洗盘", confidence: 0.7 },
  龙虎榜净买: { value: 1.2e8, label: "净买", confidence: 0.95 }, 游资席位识别: { value: 8e7, label: "游资", confidence: 0.8 },
  日线MACD: { value: 0, label: "死叉", confidence: 1 }, 周线MACD: { value: 0, label: "死叉", confidence: 1 },
};

function run(advice: boolean) {
  const view = makeView({
    asOf: `${D} 15:05:00`, tradingDays: DAYS,
    securities: [sec("600183", "主板"), sec("600888", "主板"), sec("600999", "主板"), sec("600777", "主板")],
    bars: Object.fromEntries(["600183", "600888", "600999", "600777"].map(c => [c, series(c, DAYS, [10, 10.2, 10.5, 10.8, 11])])),
    quotes: { "600183": quote("600183", 11) },
    zt: { [D]: [zt(D, "600183", { sector: "半导体", lbc: 3, sealAmt: 2e8 })] },
    sectors: { [D]: [{ date: D, ts: `${D} 14:55:00`, sector: "半导体", pct: 6.1, rank: 1, leaderCode: "600183", leaderPct: 10 } as any] },
  });
  const sectorOf = (c: string) => ({ "600183": "半导体", "600888": "半导体", "600999": "半导体", "600777": "银行" } as Record<string, string>)[c] ?? null;
  const e = createV2Engine({ registry: stubRegistry(stubs), slots: createSlotRegistry([...BASELINE_SLOTS]) });
  return e({
    view, config: config(), phase: "盘后", sectorOf,
    positions: [{ account: "卫星账户", code: "600183", cost: 10, qty: 100, stopPx: null }],
    ...(advice ? { advice: { watchlist: [{ code: "600888" }, { code: "600999" }, { code: "600777" }, { code: "600183" }] } } : {}),
  });
}

describe("引擎的持仓 / 观察池建议", () => {
  it("开建议不改变卡片的其余部分（盘前计划、影子盘不开，parity 不受影响）", () => {
    const a = run(false), b = run(true);
    const { advice, ...rest } = b;
    expect(a.advice).toBeUndefined();
    expect(rest).toEqual(a);
    expect(advice!.length).toBeGreaterThan(0);
  });

  it("持仓：纪律动作来自离场器，技术面倾向另给；已持仓的票不在观察里重复", () => {
    const adv = run(true).advice!;
    const h = adv.filter(x => x.kind === "持仓");
    expect(h.map(x => x.code)).toEqual(["600183"]);
    expect(h[0].lean).toBe("考虑减仓");                      // 日周都死叉
    expect(adv.filter(x => x.kind === "观察").map(x => x.code)).not.toContain("600183");
  });

  it("观察：在主线且过筛 → 可买；被否决 → 不买并说理由；不在主线 → 暂不买", () => {
    const w = new Map(run(true).advice!.filter(x => x.kind === "观察").map(x => [x.code, x]));
    expect(w.get("600888")).toMatchObject({ action: "可买（到触发价）", mainline: "半导体全链" });
    expect(w.get("600888")!.triggerPx).not.toBeNull();
    expect(w.get("600999")!.action).toBe("不买");
    expect(w.get("600999")!.reasons.join()).toMatch(/超买/);
    expect(w.get("600777")!.action).toBe("暂不买");
    expect(w.get("600777")!.reasons.join()).toMatch(/不在今日主线（银行）/);
  });
});
