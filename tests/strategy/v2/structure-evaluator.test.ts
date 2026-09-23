/**
 * 结构位定价评估器：在 baseline 筛完的候选上补目标位与盈亏比，并按盈亏比门槛取舍。
 *
 * 目标位优先取前高（结构位）；前高低于触发价（买入即突破）或上方无前高时，
 * 用触发价 + N 倍 ATR 兜底。两种来源写进 thesis，卡片上看得出目标是怎么来的。
 */
import { describe, it, expect } from "vitest";
import type { SignalCard, StrategyEngineInput } from "@/lib/contracts";
import { createV2Engine, createSlotRegistry, BASELINE_SLOTS } from "@/lib/strategy/v2";
import { 评估器_结构位定价 } from "@/lib/strategy/v2/slots/structure-pricing";
import { makeView, stubRegistry, config, series, sec, zt, quote, type StubValue } from "../helpers";

const DAYS = ["2026-07-28", "2026-07-29", "2026-07-30", "2026-07-31", "2026-08-03"];
const D = "2026-08-03";

function stubs(struct: Record<string, { 阻力: number | null; 支撑?: number | null; ATR: number }>): Record<string, StubValue> {
  return {
    跌停家数: { value: 5, confidence: 0.9 }, 涨停家数: { value: 60, confidence: 0.9 },
    盘面强度: { value: 80, label: "强", confidence: 0.9 }, 情绪温度: { value: 65, confidence: 0.9 },
    赚钱效应: { value: 1.5, confidence: 0.9 }, 连板高度: { value: 4, confidence: 0.9 },
    炸板率: { value: 0.1, confidence: 0.95 }, 外围传导: { value: 0.4, label: "中性", confidence: 0.8 },
    主线识别: { value: ["半导体全链"], label: "半导体全链(必查链)", confidence: 0.85,
      inputs: { 明细: [{ name: "半导体全链", sectors: ["半导体"] }] } },
    龙头温度计: { value: 2, label: "封板", confidence: 0.85 },
    过滤器: { value: 0, label: "无否决", confidence: 0.8,
      inputs: { 通过: ["位置", "换手振幅"], 否决: [], 未判定: ["催化真伪"] } },
    均线方向: { value: 1, label: "多头", confidence: 0.9 }, 量能: { value: 1.4, label: "放量", confidence: 0.9 },
    "洗盘vs派发": { value: 1, label: "洗盘", confidence: 0.7 },
    龙虎榜净买: { value: 1.2e8, label: "净买", confidence: 0.95 }, 游资席位识别: { value: 8e7, label: "游资", confidence: 0.8 },
    结构位: (p: Record<string, unknown>) => {
      const s = struct[p["code"] as string];
      return { value: null, label: s.阻力 === null ? "上方无结构位" : "有", confidence: 1,
        inputs: { 阻力: s.阻力, 支撑: s.支撑 ?? null } };
    },
    ATR: (p: Record<string, unknown>) => ({ value: 0.03, label: "", confidence: 1, inputs: { ATR: struct[p["code"] as string].ATR } }),
  };
}

function input(): StrategyEngineInput {
  return {
    view: makeView({
      asOf: `${D} 15:05:00`, tradingDays: DAYS,
      securities: [sec("600183", "主板"), sec("300750", "创业板")],
      bars: {
        "600183": series("600183", DAYS, [10, 10.2, 10.5, 10.8, 11]),
        "300750": series("300750", DAYS, [20, 20.4, 21, 21.5, 22]),
      },
      quotes: { "600183": quote("600183", 11), "300750": quote("300750", 22) },
      zt: { [D]: [
        zt(D, "600183", { sector: "半导体", lbc: 3, sealAmt: 2e8 }),
        zt(D, "300750", { sector: "半导体", lbc: 1, sealAmt: 5e7 }),
      ] },
    }),
    config: config(), phase: "盘后", positions: [],
  };
}

function run(struct: Parameters<typeof stubs>[0], params?: Record<string, unknown>): SignalCard {
  const engine = createV2Engine({
    registry: stubRegistry(stubs(struct)),
    slots: createSlotRegistry([...BASELINE_SLOTS, 评估器_结构位定价]),
  });
  return engine({ ...input(), slotConfig: { 评估器: { 用: "结构位定价", ...(params ? { 参数: params } : {}) } } as any });
}
const baseline = (struct: Parameters<typeof stubs>[0]) =>
  createV2Engine({ registry: stubRegistry(stubs(struct)), slots: createSlotRegistry([...BASELINE_SLOTS]) })(input());

const LOOSE = { 最低盈亏比: 0 };
// 夹具里 600183 在卫星账户（触发 10.89 / 止损 10.35），300750 在核心账户（没配止损）

describe("结构位定价", () => {
  it("上方有前高：目标 = 前高，盈亏比 = (目标 − 触发) / (触发 − 止损)", () => {
    const card = run({ "600183": { 阻力: 14, ATR: 0.5 }, "300750": { 阻力: 30, ATR: 1 } }, LOOSE);
    const c = card.candidates.find(x => x.code === "600183")!;
    expect(c.targetPx).toBe(14);
    expect(c.rrRatio).toBeCloseTo((14 - c.triggerPx!) / (c.triggerPx! - c.stopPx!), 2);
    expect(c.thesis).toMatch(/目标 14（前高）/);
  });

  it("上方无结构位 → 触发价 + 3 × ATR 兜底，thesis 写明来源", () => {
    const card = run({ "600183": { 阻力: 14, ATR: 0.5 }, "300750": { 阻力: null, ATR: 1 } }, LOOSE);
    const c = card.candidates.find(x => x.code === "300750")!;
    expect(c.targetPx).toBeCloseTo(c.triggerPx! + 3, 2);
    expect(c.thesis).toMatch(/ATR×3/);
  });

  it("前高低于触发价（买入即突破它）→ 同样改用 ATR 兜底，不拿一个已经被突破的位置当目标", () => {
    const card = run({ "600183": { 阻力: 10.8, ATR: 0.5 }, "300750": { 阻力: 30, ATR: 1 } }, LOOSE);
    const c = card.candidates.find(x => x.code === "600183")!;
    expect(c.targetPx!).toBeGreaterThan(c.triggerPx!);
    expect(c.thesis).toMatch(/ATR×3/);
  });

  it("盈亏比低于门槛 → 不进候选，并在卡片上说明为什么少了一只", () => {
    const card = run({ "600183": { 阻力: 14, ATR: 0.5 }, "300750": { 阻力: 30, ATR: 1 } }, { 最低盈亏比: 50 });
    expect(card.candidates.map(c => c.code)).not.toContain("600183");
    expect(card.warnings.some(w => /600183 盈亏比 .* < 门槛 50/.test(w))).toBe(true);
  });

  it("账户没配止损 → 盈亏比 null、不剔除但告警（那是配置问题，不是票的问题）", () => {
    const card = run({ "600183": { 阻力: 14, ATR: 0.5 }, "300750": { 阻力: 30, ATR: 1 } }, { 最低盈亏比: 50 });
    const c = card.candidates.find(x => x.code === "300750")!;
    expect(c.rrRatio).toBeNull();
    expect(card.warnings.some(w => /300750 .*没有止损价/.test(w))).toBe(true);
  });

  it("按盈亏比排序：算得出盈亏比的在前，算不出的排最后", () => {
    const card = run({ "600183": { 阻力: 11.5, ATR: 0.1 }, "300750": { 阻力: 40, ATR: 1 } }, LOOSE);
    expect(card.candidates.map(c => c.code)).toEqual(["600183", "300750"]);
  });

  it("目标位取整到分：前高是后复权价除回来的，带浮点尾巴，券商挂不了", () => {
    const card = run({ "600183": { 阻力: 14.030673, ATR: 0.5 }, "300750": { 阻力: 30, ATR: 1 } }, LOOSE);
    expect(card.candidates.find(x => x.code === "600183")!.targetPx).toBe(14.03);
  });

  it("baseline 的卡片不带目标位字段 —— 对照组口径不变", () => {
    const card = baseline({ "600183": { 阻力: 14, ATR: 0.5 }, "300750": { 阻力: 30, ATR: 1 } });
    for (const c of card.candidates) {
      expect("targetPx" in c).toBe(false);
      expect("rrRatio" in c).toBe(false);
    }
  });

  it("结构位与 ATR 的读数进 factors，复盘时看得到目标是按什么算的", () => {
    const card = run({ "600183": { 阻力: 14, ATR: 0.5 }, "300750": { 阻力: 30, ATR: 1 } }, LOOSE);
    const names = card.candidates[0].factors.map(f => f.name);
    expect(names).toEqual(expect.arrayContaining(["结构位", "ATR"]));
  });
});
