/**
 * 规则引擎。
 *
 * 被测的是"这组因子读数下应该出什么动作"，所以因子全用桩。
 * 重点不在覆盖率，在几条不许错的纪律：
 *   防守 = 0 仓；没有 thesis 不进候选池；缺数据必须进 warnings；时间只来自 view.asOf。
 */
import { describe, it, expect } from "vitest";
import type { StrategyEngineInput } from "@/lib/contracts";
import { createStrategyEngine, LOW_CONFIDENCE } from "@/lib/strategy/engine";
import {
  makeView, stubRegistry, config, series, bar, sec, zt, quote,
  type StubValue,
} from "./helpers";

const DAYS = ["2026-07-28", "2026-07-29", "2026-07-30", "2026-07-31", "2026-08-03"];
const D = "2026-08-03";

/** 一个"进攻"底色的因子桩集合，各用例只覆盖自己关心的那几个 */
function baseStubs(over: Record<string, StubValue> = {}): Record<string, StubValue> {
  return {
    跌停家数: { value: 5, provenance: "proxy", confidence: 0.9 },
    涨停家数: { value: 60, provenance: "proxy", confidence: 0.9 },
    盘面强度: { value: 80, label: "强", provenance: "proxy", confidence: 0.9 },
    情绪温度: { value: 65, provenance: "proxy", confidence: 0.9 },
    赚钱效应: { value: 1.5, provenance: "proxy", confidence: 0.9 },
    连板高度: { value: 4, provenance: "proxy", confidence: 0.9 },
    炸板率: { value: 0.1, confidence: 0.95 },
    外围传导: { value: 0.4, label: "中性", confidence: 0.8 },
    主线识别: {
      value: ["半导体全链"], label: "半导体全链(必查链)", confidence: 0.85,
      inputs: { 明细: [{ name: "半导体全链", leaderCode: "600183", maxLbc: 3 }] },
    },
    龙头温度计: { value: 2, label: "封板", confidence: 0.85 },
    过滤器: {
      value: 0, label: "七道筛无否决（2 道未判定）", confidence: 5 / 7,
      inputs: { 通过: ["位置", "换手振幅", "权限账户", "打法匹配", "目标匹配"], 否决: [], 未判定: ["估值基本面", "催化真伪"] },
    },
    均线方向: { value: 1, label: "多头", confidence: 0.9 },
    量能: { value: 1.4, label: "放量", confidence: 0.9 },
    "洗盘vs派发": { value: 1, label: "洗盘", confidence: 0.7 },
    龙虎榜净买: { value: 1.2e8, label: "净买 1.2 亿", confidence: 0.95 },
    游资席位识别: { value: 8e7, label: "游资净买", confidence: 0.8 },
    ...over,
  };
}

function makeInput(over: Partial<StrategyEngineInput> & {
  stubs?: Record<string, StubValue>;
} = {}): { input: StrategyEngineInput; stubs: Record<string, StubValue> } {
  const stubs = over.stubs ?? baseStubs();
  const view = over.view ?? makeView({
    asOf: `${D} 15:05:00`,
    tradingDays: DAYS,
    securities: [sec("600183", "主板"), sec("300750", "创业板"), sec("830799", "北交所")],
    bars: {
      "600183": series("600183", DAYS, [10, 10.2, 10.5, 10.8, 11]),
      "300750": series("300750", DAYS, [20, 20.4, 21, 21.5, 22]),
      "830799": series("830799", DAYS, [5, 5.1, 5.2, 5.3, 5.4]),
    },
    quotes: { "600183": quote("600183", 11), "300750": quote("300750", 22) },
    zt: { [D]: [zt(D, "600183", { sector: "半导体", lbc: 3 })] },
  });
  return {
    stubs,
    input: {
      view,
      config: over.config ?? config(),
      phase: over.phase ?? "盘后",
      positions: over.positions ?? [],
    },
  };
}

function run(over: Parameters<typeof makeInput>[0] = {}) {
  const { input, stubs } = makeInput(over);
  const engine = createStrategyEngine({ registry: stubRegistry(stubs) });
  return engine(input);
}

/* ------------------------------ 环境与档位 ------------------------------ */

describe("环境档位", () => {
  it("盘面强度高 + 有主线 → 进攻，目标仓位取档位与总仓位上限的较小值", () => {
    const card = run();
    expect(card.env.gear).toBe("进攻");
    expect(card.env.targetPosition).toBe(0.7);
    expect(card.env.reasons.join(" ")).toMatch(/盘面强度|主线/);
  });

  it("盘面强度中等 → 中性", () => {
    const card = run({ stubs: baseStubs({ 盘面强度: { value: 52, label: "中性", confidence: 0.9 } }) });
    expect(card.env.gear).toBe("中性");
    expect(card.env.targetPosition).toBe(0.4);
  });

  it("跌停家数超阈值 → 防守，且目标仓位是 0 而不是轻仓", () => {
    const card = run({ stubs: baseStubs({ 跌停家数: { value: 45, provenance: "proxy", confidence: 0.9 } }) });
    expect(card.env.gear).toBe("防守");
    expect(card.env.targetPosition).toBe(0);
    expect(card.env.reasons.some(r => r.includes("跌停家数") && r.includes("45"))).toBe(true);
  });

  it("外围 risk_off → 防守（布尔型条件按因子 label 判）", () => {
    const card = run({ stubs: baseStubs({ 外围传导: { value: -1.8, label: "risk_off", confidence: 0.8 } }) });
    expect(card.env.gear).toBe("防守");
    expect(card.env.reasons.some(r => r.includes("外围"))).toBe(true);
  });

  it("外围因子没数据（confidence 0）时不触发防守，但要进 warnings", () => {
    // 外围表是空的（上线起攒），把"没数据"当成 risk_off 会让系统永久防守。
    const card = run({
      stubs: baseStubs({
        外围传导: { value: null, label: "外围数据未积累（macro 上线起攒，无历史）", confidence: 0 },
      }),
    });
    expect(card.env.gear).toBe("进攻");
    expect(card.warnings.join(" ")).toContain("外围传导");
  });

  it("权重杀跌 没有对应因子 → 不当成 false 放过，列进 warnings 的未判定条件", () => {
    const card = run();
    expect(card.warnings.some(w => w.includes("权重杀跌") && w.includes("未判定"))).toBe(true);
    // 未判定 ≠ 触发：其它条件都不成立时档位不该被拖进防守
    expect(card.env.gear).toBe("进攻");
  });

  it("低置信因子同时进 env.lowConfidenceFactors 与 warnings，不藏", () => {
    const card = run({ stubs: baseStubs({ 情绪温度: { value: 70, provenance: "proxy", confidence: 0.55 } }) });
    expect(card.env.lowConfidenceFactors).toContain("情绪温度");
    expect(card.warnings.some(w => w.includes("情绪温度") && w.includes("0.55"))).toBe(true);
    expect(LOW_CONFIDENCE).toBe(0.8);
  });

  it("环境因子缺失（注册表里没有）时告警而不是抛错", () => {
    const stubs = baseStubs();
    delete stubs["盘面强度"];
    const card = run({ stubs });
    expect(card.warnings.some(w => w.includes("盘面强度") && w.includes("未注册"))).toBe(true);
    // 拿不到盘面强度就不该敢开进攻档
    expect(card.env.gear).not.toBe("进攻");
  });

  it("env.factors 带上参与决策的因子读数，供复盘归因", () => {
    const card = run();
    expect(card.env.factors.map(f => f.name)).toContain("涨停家数");
    expect(card.env.factors.every(f => typeof f.confidence === "number")).toBe(true);
  });
});

/* -------------------------------- 候选池 -------------------------------- */

describe("候选池", () => {
  it("主线板块内的涨停票进候选，带触发价/止损价/thesis", () => {
    const card = run();
    const c = card.candidates.find(x => x.code === "600183");
    expect(c).toBeDefined();
    expect(c!.action).toBe("买入");
    expect(c!.account).toBe("卫星");
    // 不追高：触发价不高于最新收盘（回踩企稳低吸）
    expect(c!.triggerPx).not.toBeNull();
    expect(c!.triggerPx!).toBeLessThanOrEqual(11);
    // 止损 -5%，且按分取整 —— 止损价是要挂进券商的真实价格，不是浮点数
    expect(c!.stopPx).toBe(Math.round(c!.triggerPx! * 0.95 * 100) / 100);
    expect(c!.thesis.length).toBeGreaterThan(0);
    expect(c!.thesis).toContain("半导体");
  });

  it("防守档下候选池为空 —— 0 仓就是不开新仓", () => {
    const card = run({ stubs: baseStubs({ 跌停家数: { value: 45, confidence: 0.9 } }) });
    expect(card.candidates).toEqual([]);
    expect(card.env.reasons.join(" ")).toMatch(/防守/);
  });

  it("七道筛有否决的票不进候选池", () => {
    const card = run({
      stubs: baseStubs({
        过滤器: {
          value: 1, label: "否决：位置", confidence: 5 / 7,
          inputs: { 通过: [], 否决: ["位置"], 未判定: ["估值基本面", "催化真伪"] },
        },
      }),
    });
    expect(card.candidates.map(c => c.code)).not.toContain("600183");
    expect(card.warnings.some(w => w.includes("否决"))).toBe(true);
  });

  it("讲不出逻辑的票不进候选池 —— 一句话都写不出来的不许买", () => {
    const stubs = baseStubs({
      主线识别: { value: [], label: "", confidence: 0.4, inputs: { 明细: [] } },
      龙头温度计: { value: 0, label: "无涨停池数据", confidence: 0 },
      均线方向: { value: 0, label: "样本不足", confidence: 0.2 },
      量能: { value: 1, label: "平量", confidence: 0.3 },
      龙虎榜净买: { value: null, label: "当日未上榜", confidence: 0.5 },
      游资席位识别: { value: 0, label: "无席位明细", confidence: 0 },
    });
    const card = run({ stubs });
    expect(card.candidates).toEqual([]);
  });

  it("创业板票落到核心账户，主板票落到卫星账户（权限×账户）", () => {
    const view = makeView({
      asOf: `${D} 15:05:00`, tradingDays: DAYS,
      securities: [sec("600183", "主板"), sec("300750", "创业板")],
      bars: {
        "600183": series("600183", DAYS, [10, 10.2, 10.5, 10.8, 11]),
        "300750": series("300750", DAYS, [20, 20.4, 21, 21.5, 22]),
      },
      zt: { [D]: [zt(D, "600183", { sector: "半导体" }), zt(D, "300750", { sector: "半导体" })] },
    });
    const card = run({ view });
    expect(card.candidates.find(c => c.code === "600183")!.account).toBe("卫星");
    expect(card.candidates.find(c => c.code === "300750")!.account).toBe("核心");
  });

  it("北交所票两个账户都不做，直接不进候选", () => {
    const view = makeView({
      asOf: `${D} 15:05:00`, tradingDays: DAYS,
      securities: [sec("830799", "北交所")],
      bars: { "830799": series("830799", DAYS, [5, 5.1, 5.2, 5.3, 5.4]) },
      zt: { [D]: [zt(D, "830799", { sector: "半导体" })] },
    });
    const card = run({ view });
    expect(card.candidates).toEqual([]);
  });

  it("已持仓的票不重复进新开仓池，只出现在 holdings", () => {
    const card = run({
      positions: [{ account: "卫星", code: "600183", cost: 10, qty: 1000, stopPx: 9.5 }],
    });
    expect(card.candidates.map(c => c.code)).not.toContain("600183");
    expect(card.holdings.map(h => h.code)).toContain("600183");
  });

  it("非主线板块的涨停票不进候选（不追杂毛）", () => {
    const view = makeView({
      asOf: `${D} 15:05:00`, tradingDays: DAYS,
      securities: [sec("600999", "主板")],
      bars: { "600999": series("600999", DAYS, [8, 8.1, 8.2, 8.3, 8.4]) },
      zt: { [D]: [zt(D, "600999", { sector: "白酒" })] },
    });
    const card = run({ view });
    expect(card.candidates).toEqual([]);
  });

  it("没有日线就没有触发价，不进候选（不许拿空气定价）", () => {
    const view = makeView({
      asOf: `${D} 15:05:00`, tradingDays: DAYS,
      securities: [sec("600183", "主板")],
      bars: {},
      zt: { [D]: [zt(D, "600183", { sector: "半导体" })] },
    });
    const card = run({ view });
    expect(card.candidates).toEqual([]);
  });
});

/* ------------------------------- 组合风控 ------------------------------- */

describe("组合风控", () => {
  const manyView = (n: number) => {
    const codes = Array.from({ length: n }, (_, i) => `60000${i}`);
    return makeView({
      asOf: `${D} 15:05:00`, tradingDays: DAYS,
      securities: codes.map(c => sec(c, "主板")),
      bars: Object.fromEntries(codes.map(c => [c, series(c, DAYS, [10, 10.2, 10.5, 10.8, 11])])),
      zt: { [D]: codes.map(c => zt(D, c, { sector: "半导体" })) },
    });
  };

  it("单票不超过 单票最大占比", () => {
    const card = run({ view: manyView(1) });
    for (const c of card.candidates) expect(c.size).toBeLessThanOrEqual(0.15 + 1e-9);
  });

  it("同板块合计不超过 单行业最大占比", () => {
    const card = run({ view: manyView(8) });
    const sum = card.candidates.reduce((a, c) => a + c.size, 0);
    expect(sum).toBeLessThanOrEqual(0.35 + 1e-9);
  });

  it("卫星账户合计不超过 卫星比例 × 目标仓位", () => {
    const card = run({ view: manyView(8) });
    const 卫星 = card.candidates.filter(c => c.account === "卫星").reduce((a, c) => a + c.size, 0);
    expect(卫星).toBeLessThanOrEqual(0.7 * 0.4 + 1e-9);
  });

  it("被上限挤掉的票降级为观察，并写明是哪条上限挤的", () => {
    const card = run({ view: manyView(8) });
    const 观察 = card.candidates.filter(c => c.action === "观察");
    expect(观察.length).toBeGreaterThan(0);
    expect(观察[0].size).toBe(0);
    expect(观察[0].rejectedBy!.join(" ")).toMatch(/占比|上限/);
  });

  it("无法核算现有持仓占比时必须告警 —— 引擎拿不到总资产", () => {
    const card = run({ positions: [{ account: "卫星", code: "000001", cost: 10, qty: 1000, stopPx: null }] });
    expect(card.warnings.some(w => w.includes("总资产") || w.includes("现有持仓"))).toBe(true);
  });
});

/* -------------------------------- 持仓动作 -------------------------------- */

describe("持仓动作", () => {
  const held = (over: Partial<{ cost: number; stopPx: number | null; account: "卫星" | "核心" }> = {}) => ([{
    account: over.account ?? "卫星" as const,
    code: "600183", cost: over.cost ?? 10.8, qty: 1000,
    stopPx: over.stopPx === undefined ? 9.5 : over.stopPx,
  }]);

  it("正常持仓 → 持有", () => {
    const card = run({ positions: held() });
    const h = card.holdings[0];
    expect(h.action).toBe("持有");
    expect(h.size).toBe(1);
  });

  it("盘中破止损 + 止损确认=收盘 → 观察，不当场砍", () => {
    // 政策底/外围硬驱动的反弹日，盘中单次冲高回落多数是洗盘不是见光死。
    const view = makeView({
      asOf: `${D} 11:20:00`, tradingDays: DAYS,
      securities: [sec("600183", "主板")],
      bars: { "600183": series("600183", DAYS, [10, 10, 10, 10, 9.4]) },
      quotes: { "600183": quote("600183", 9.4) },
    });
    const card = run({ view, phase: "盘中", positions: held({ cost: 10, stopPx: 9.5 }) });
    const h = card.holdings[0];
    expect(h.action).toBe("观察");
    expect(h.thesis).toMatch(/收盘/);
  });

  it("盘后破止损 → 清仓", () => {
    const view = makeView({
      asOf: `${D} 15:05:00`, tradingDays: DAYS,
      securities: [sec("600183", "主板")],
      bars: { "600183": series("600183", DAYS, [10, 10, 10, 10, 9.4]) },
      quotes: { "600183": quote("600183", 9.4) },
    });
    const card = run({ view, phase: "盘后", positions: held({ cost: 10, stopPx: 9.5 }) });
    expect(card.holdings[0].action).toBe("清仓");
    expect(card.holdings[0].size).toBe(0);
  });

  it("跌破灾难位 → 盘中也立刻清仓（灾难位就是为了越过收盘确认）", () => {
    const view = makeView({
      asOf: `${D} 11:20:00`, tradingDays: DAYS,
      securities: [sec("600183", "主板")],
      bars: { "600183": series("600183", DAYS, [10, 10, 10, 10, 9.1]) },
      quotes: { "600183": quote("600183", 9.1) },
    });
    const card = run({ view, phase: "盘中", positions: held({ cost: 10, stopPx: 9.5 }) });
    expect(card.holdings[0].action).toBe("清仓");
    expect(card.holdings[0].thesis).toMatch(/灾难位/);
  });

  it("浮盈到第一档止盈 → 减仓一半", () => {
    const view = makeView({
      asOf: `${D} 15:05:00`, tradingDays: DAYS,
      securities: [sec("600183", "主板")],
      bars: { "600183": series("600183", DAYS, [10, 10, 10, 10, 10.9]) },
      quotes: { "600183": quote("600183", 10.9) },
    });
    const card = run({ view, positions: held({ cost: 10, stopPx: 9.5 }) });
    expect(card.holdings[0].action).toBe("减仓");
    expect(card.holdings[0].size).toBe(0.5);
  });

  it("浮盈到第二档止盈 → 清仓", () => {
    const view = makeView({
      asOf: `${D} 15:05:00`, tradingDays: DAYS,
      securities: [sec("600183", "主板")],
      bars: { "600183": series("600183", DAYS, [10, 10, 10, 10, 11.6]) },
      quotes: { "600183": quote("600183", 11.6) },
    });
    const card = run({ view, positions: held({ cost: 10, stopPx: 9.5 }) });
    expect(card.holdings[0].action).toBe("清仓");
  });

  it("防守档下所有持仓都清 —— 0 仓不留过冬仓位", () => {
    const card = run({
      stubs: baseStubs({ 跌停家数: { value: 45, confidence: 0.9 } }),
      positions: held(),
    });
    expect(card.holdings.every(h => h.action === "清仓")).toBe(true);
    expect(card.holdings[0].thesis).toMatch(/防守/);
  });

  it("核心账户止损是 逻辑破坏，不给机械止损价，只提示复核", () => {
    const view = makeView({
      asOf: `${D} 15:05:00`, tradingDays: DAYS,
      securities: [sec("300750", "创业板")],
      bars: { "300750": series("300750", DAYS, [20, 20, 20, 20, 17]) },
      quotes: { "300750": quote("300750", 17) },
    });
    const card = run({
      view,
      positions: [{ account: "核心", code: "300750", cost: 20, qty: 100, stopPx: null }],
    });
    const h = card.holdings[0];
    expect(h.stopPx).toBeNull();
    expect(h.action).toBe("观察");
    expect(h.thesis).toMatch(/逻辑/);
  });

  it("拿不到价格的持仓 → 观察 + 告警，不假装还在赚钱", () => {
    const view = makeView({
      asOf: `${D} 15:05:00`, tradingDays: DAYS,
      securities: [sec("600183", "主板")], bars: {},
    });
    const card = run({ view, positions: held() });
    expect(card.holdings[0].action).toBe("观察");
    expect(card.warnings.some(w => w.includes("600183") && w.includes("价格"))).toBe(true);
  });
});

/* ------------------------------ 卡片与纪律 ------------------------------ */

describe("信号卡", () => {
  it("ts 来自 view.asOf，不取系统时间", () => {
    const card = run();
    expect(card.ts).toBe(`${D} 15:05:00`);
  });

  it("phase 与 strategyId 原样带上", () => {
    const card = run({ phase: "盘前" });
    expect(card.phase).toBe("盘前");
    expect(card.strategyId).toBe("t");
  });

  it("advisorInfluenced 恒为 false —— 引擎本身不调 Advisor", () => {
    expect(run().advisorInfluenced).toBe(false);
  });

  it("当日有数据缺口时必须出现在 warnings", () => {
    const view = makeView({
      asOf: `${D} 15:05:00`, tradingDays: DAYS,
      securities: [sec("600183", "主板")],
      bars: { "600183": series("600183", DAYS, [10, 10.2, 10.5, 10.8, 11]) },
      zt: { [D]: [zt(D, "600183", { sector: "半导体" })] },
      gaps: { [D]: ["zt_pool"] },
    });
    const card = run({ view });
    expect(card.warnings.some(w => w.includes("缺口") && w.includes("zt_pool"))).toBe(true);
  });

  it("七道筛未判定的项要抬到卡上 —— 缺基本面/消息面不能宣称全过", () => {
    const card = run();
    expect(card.warnings.some(w => w.includes("估值基本面") || w.includes("未判定"))).toBe(true);
  });

  it("同一份输入跑两次结果完全一致（spec §17 断言 4）", () => {
    const a = JSON.stringify(run());
    const b = JSON.stringify(run());
    expect(a).toBe(b);
  });

  it("候选与持仓按确定顺序排列 —— 顺序抖动会让回测哈希对不上", () => {
    const cardA = run({ view: undefined });
    const cardB = run({ view: undefined });
    expect(cardA.candidates.map(c => c.code)).toEqual(cardB.candidates.map(c => c.code));
  });

  it("空数据的视图也能跑通不抛错", () => {
    const view = makeView({ asOf: D });
    expect(() => run({ view })).not.toThrow();
    const card = run({ view });
    expect(card.candidates).toEqual([]);
    expect(card.warnings.length).toBeGreaterThan(0);
  });
});
