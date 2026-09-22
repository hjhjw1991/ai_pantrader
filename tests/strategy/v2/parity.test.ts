/**
 * v2（baseline 槽组合）必须与 v1 产出同一张卡。
 *
 * 这条是整个 v2 的**验收判据**，不是锦上添花：
 * 影子盘里新策略的毕业门槛是"打赢 baseline"，若对照组与历史口径对不上，
 * 赢了输了都说明不了任何事——而"对不上"是悄悄发生的，没有这个测试就看不见。
 *
 * warnings 按**集合**比对而不是数组：v2 把主线识别拆成了独立的槽，
 * 于是它先于环境因子求值，告警的产生顺序随之变化。内容一条不少、一条不多，
 * 只是次序不同。次序在**同一个引擎内部**必须稳定（结果哈希依赖它），
 * 但跨引擎比对次序没有意义。
 */
import { describe, it, expect } from "vitest";
import type { SignalCard, StrategyEngineInput } from "@/lib/contracts";
import { createStrategyEngine } from "@/lib/strategy/engine";
import { createV2Engine, createSlotRegistry, BASELINE_SLOTS } from "@/lib/strategy/v2";
import {
  makeView, stubRegistry, config, series, sec, zt, quote, type StubValue,
} from "../helpers";

const DAYS = ["2026-07-28", "2026-07-29", "2026-07-30", "2026-07-31", "2026-08-03"];
const D = "2026-08-03";

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
      inputs: { 明细: [{ name: "半导体全链", leaderCode: "600183", maxLbc: 3, sectors: ["半导体"] }] },
    },
    龙头温度计: { value: 2, label: "封板", confidence: 0.85 },
    过滤器: {
      value: 0, label: "七道筛无否决（2 道未判定）", confidence: 5 / 7,
      inputs: {
        通过: ["位置", "换手振幅", "权限账户", "打法匹配", "目标匹配"],
        否决: [], 未判定: ["估值基本面", "催化真伪"],
      },
    },
    均线方向: { value: 1, label: "多头", confidence: 0.9 },
    量能: { value: 1.4, label: "放量", confidence: 0.9 },
    "洗盘vs派发": { value: 1, label: "洗盘", confidence: 0.7 },
    龙虎榜净买: { value: 1.2e8, label: "净买 1.2 亿", confidence: 0.95 },
    游资席位识别: { value: 8e7, label: "游资净买", confidence: 0.8 },
    ...over,
  };
}

function makeInput(over: Partial<StrategyEngineInput> = {}): StrategyEngineInput {
  return {
    view: over.view ?? makeView({
      asOf: `${D} 15:05:00`,
      tradingDays: DAYS,
      securities: [sec("600183", "主板"), sec("300750", "创业板"), sec("830799", "北交所")],
      bars: {
        "600183": series("600183", DAYS, [10, 10.2, 10.5, 10.8, 11]),
        "300750": series("300750", DAYS, [20, 20.4, 21, 21.5, 22]),
        "830799": series("830799", DAYS, [5, 5.1, 5.2, 5.3, 5.4]),
      },
      quotes: { "600183": quote("600183", 11), "300750": quote("300750", 22) },
      zt: {
        [D]: [
          zt(D, "600183", { sector: "半导体", lbc: 3, sealAmt: 2e8 }),
          zt(D, "300750", { sector: "半导体", lbc: 1, sealAmt: 5e7 }),
        ],
      },
      sectors: {
        [D]: [{
          date: D, ts: `${D} 14:55:00`, sector: "半导体", pct: 6.1, rank: 1,
          leaderCode: "600183", leaderPct: 10,
        } as any],
      },
    }),
    config: over.config ?? config(),
    phase: over.phase ?? "盘后",
    positions: over.positions ?? [],
    sectorOf: over.sectorOf,
    sectorMapAt: over.sectorMapAt,
  };
}

function bothEngines(
  input: StrategyEngineInput, stubs: Record<string, StubValue> = baseStubs()
): { v1: SignalCard; v2: SignalCard } {
  // 两边各拿一份独立的注册表：桩是纯函数，但共用实例会让"低置信只告警一次"
  // 这种带记忆的行为在两个引擎之间串味
  const v1 = createStrategyEngine({ registry: stubRegistry(stubs) })(input);
  const v2 = createV2Engine({
    registry: stubRegistry(stubs),
    slots: createSlotRegistry([...BASELINE_SLOTS]),
  })(input);
  return { v1, v2 };
}

/** 逐字段比对；warnings 单独按集合比 */
function expectParity(v1: SignalCard, v2: SignalCard): void {
  expect(v2.ts).toBe(v1.ts);
  expect(v2.phase).toBe(v1.phase);
  expect(v2.strategyId).toBe(v1.strategyId);
  expect(v2.strategyName).toBe(v1.strategyName);
  expect(v2.advisorInfluenced).toBe(v1.advisorInfluenced);

  expect(v2.env.gear).toBe(v1.env.gear);
  expect(v2.env.targetPosition).toBe(v1.env.targetPosition);
  expect(v2.env.reasons).toEqual(v1.env.reasons);
  expect(v2.env.lowConfidenceFactors).toEqual(v1.env.lowConfidenceFactors);
  // 比全量而不是只比名字：只比名字的话，因子的 value / confidence / label 悄悄变了照样通过，
  // 而那正是"两个引擎其实在用不同读数做决策"最可能的表现形式
  expect(v2.env.factors).toEqual(v1.env.factors);

  expect(v2.candidates).toEqual(v1.candidates);
  expect(v2.holdings).toEqual(v1.holdings);

  expect([...v2.warnings].sort()).toEqual([...v1.warnings].sort());
}

describe("v2 baseline 与 v1 等价", () => {
  it("进攻档 + 有候选：整张卡逐字段一致", () => {
    const { v1, v2 } = bothEngines(makeInput());
    expect(v1.env.gear).toBe("进攻");        // 先确认这一轮确实走到了有候选的分支
    expect(v1.candidates.length).toBeGreaterThan(0);
    expectParity(v1, v2);
  });

  it("防守档：两边都清零候选、都给清仓动作", () => {
    const input = makeInput({
      positions: [{ account: "卫星账户", code: "600183", cost: 10, qty: 100, stopPx: null }],
    });
    const { v1, v2 } = bothEngines(input, baseStubs({ 跌停家数: { value: 80, confidence: 0.9 } }));
    expect(v1.env.gear).toBe("防守");
    expect(v1.candidates).toEqual([]);
    expectParity(v1, v2);
  });

  it("带持仓：离场器产出与 v1 的持仓动作一致", () => {
    const input = makeInput({
      positions: [
        { account: "卫星账户", code: "600183", cost: 12, qty: 100, stopPx: null },
        { account: "核心账户", code: "300750", cost: 20, qty: 200, stopPx: null },
      ],
    });
    const { v1, v2 } = bothEngines(input);
    expect(v1.holdings.length).toBe(2);
    expectParity(v1, v2);
  });

  it("没有主线时：两边都只剩兜底候选，且告警内容一致", () => {
    const { v1, v2 } = bothEngines(
      makeInput(),
      baseStubs({ 主线识别: { value: [], label: "无主线", confidence: 0.5 } })
    );
    expect(v1.env.gear).toBe("中性");
    expectParity(v1, v2);
  });

  it("盘中阶段 + 破止损：止损确认=收盘 的分支两边一致", () => {
    const input = makeInput({
      phase: "盘中",
      // 现价 11，成本 11.7 → 浮亏 -5.98%：破了止损 -5%，但还没到灾难位 -8%。
      // 落在这个窄区间才走得到"等收盘确认"那条分支；再亏一点就直接清仓了
      positions: [{ account: "卫星账户", code: "600183", cost: 11.7, qty: 100, stopPx: null }],
    });
    const { v1, v2 } = bothEngines(input);
    expect(v1.holdings[0].action).toBe("观察");
    expectParity(v1, v2);
  });

  it("数据缺口日：缺口告警两边都上卡", () => {
    const view = makeView({
      asOf: `${D} 15:05:00`,
      tradingDays: DAYS,
      securities: [sec("600183", "主板")],
      bars: { "600183": series("600183", DAYS, [10, 10.2, 10.5, 10.8, 11]) },
      zt: { [D]: [zt(D, "600183", { sector: "半导体", lbc: 3 })] },
      gaps: { [D]: ["zt_pool"] },
    });
    const { v1, v2 } = bothEngines(makeInput({ view }));
    expect(v1.warnings.some(x => x.includes("zt_pool"))).toBe(true);
    expectParity(v1, v2);
  });
});

describe("槽位装配的硬约束", () => {
  it("槽位名配错直接抛错，不静默退回默认实现 —— 悄悄用了别的实现，影子盘的归因就废了", () => {
    const engine = createV2Engine({
      registry: stubRegistry(baseStubs()),
      slots: createSlotRegistry([...BASELINE_SLOTS]),
    });
    expect(() => engine({
      ...makeInput(),
      slotConfig: { 择时器: { 用: "不存在的择时器" } },
    })).toThrow(/不存在的择时器/);
  });

  it("不写 槽位 段就用 baseline —— 现存 YAML 一份都没有这段，不该因为引擎升级就跑不起来", () => {
    const { v1, v2 } = bothEngines(makeInput());
    expectParity(v1, v2);
  });
});
