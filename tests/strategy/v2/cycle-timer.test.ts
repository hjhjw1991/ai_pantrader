/**
 * 五段状态机择时器：阶段 → 档位，且防守触发不可被阶段推翻。
 */
import { describe, it, expect } from "vitest";
import type { SignalCard, StrategyEngineInput } from "@/lib/contracts";
import { createV2Engine, createSlotRegistry, BASELINE_SLOTS, 择时器_五段状态机 } from "@/lib/strategy/v2";
import { makeView, stubRegistry, config, series, sec, zt, quote, type StubValue } from "../helpers";

const DAYS = ["2026-07-28", "2026-07-29", "2026-07-30", "2026-07-31", "2026-08-03"];
const D = "2026-08-03";

function stubs(stage: string | null, over: Record<string, StubValue> = {}): Record<string, StubValue> {
  return {
    跌停家数: { value: 5, confidence: 0.9 }, 涨停家数: { value: 60, confidence: 0.9 },
    盘面强度: { value: 50, label: "中", confidence: 0.9 }, 情绪温度: { value: 65, confidence: 0.9 },
    赚钱效应: { value: 1.5, confidence: 0.9 }, 连板高度: { value: 4, confidence: 0.9 },
    炸板率: { value: 0.1, confidence: 0.95 }, 外围传导: { value: 0.4, label: "中性", confidence: 0.8 },
    主线识别: { value: ["半导体全链"], label: "半导体全链(必查链)", confidence: 0.85,
      inputs: { 明细: [{ name: "半导体全链", sectors: ["半导体"] }] } },
    龙头温度计: { value: 2, label: "封板", confidence: 0.85 },
    过滤器: { value: 0, label: "无否决", confidence: 0.8, inputs: { 通过: ["位置"], 否决: [], 未判定: [] } },
    均线方向: { value: 1, label: "多头", confidence: 0.9 }, 量能: { value: 1.4, label: "放量", confidence: 0.9 },
    "洗盘vs派发": { value: 1, label: "洗盘", confidence: 0.7 },
    龙虎榜净买: { value: 1.2e8, label: "净买", confidence: 0.95 }, 游资席位识别: { value: 8e7, label: "游资", confidence: 0.8 },
    情绪阶段: stage === null
      ? { value: null, label: "样本不足", confidence: 0 }
      : { value: 0.9, label: stage, confidence: 0.8, inputs: { 热度: 0.9, 持续天数: 4 } },
    ...over,
  };
}

function input(): StrategyEngineInput {
  return {
    view: makeView({
      asOf: `${D} 15:05:00`, tradingDays: DAYS,
      securities: [sec("600183", "主板")],
      bars: { "600183": series("600183", DAYS, [10, 10.2, 10.5, 10.8, 11]) },
      quotes: { "600183": quote("600183", 11) },
      zt: { [D]: [zt(D, "600183", { sector: "半导体", lbc: 3, sealAmt: 2e8 })] },
    }),
    config: config(), phase: "盘后", positions: [],
  };
}

function run(stage: string | null, over: Record<string, StubValue> = {}, params?: Record<string, unknown>): SignalCard {
  const engine = createV2Engine({
    registry: stubRegistry(stubs(stage, over)),
    slots: createSlotRegistry([...BASELINE_SLOTS, 择时器_五段状态机]),
  });
  return engine({ ...input(), slotConfig: { 择时器: { 用: "五段状态机", ...(params ? { 参数: params } : {}) } } as any });
}

describe("五段状态机择时器", () => {
  it.each([
    ["冰点", "中性"], ["启动", "进攻"], ["发酵", "进攻"], ["高潮", "中性"], ["退潮", "防守"],
  ])("%s → %s（默认映射：冰点建仓、启动发酵进攻、高潮不追、退潮空仓）", (stage, gear) => {
    const card = run(stage);
    expect(card.env.gear).toBe(gear);
    expect(card.stage).toBe(stage);
  });

  it("退潮 = 防守 = 目标仓位 0，不出新候选", () => {
    const card = run("退潮");
    expect(card.env.targetPosition).toBe(0);
    expect(card.candidates).toEqual([]);
  });

  it("防守触发（跌停家数 > 30）不可被阶段推翻：发酵期遇跌停潮照样防守", () => {
    const card = run("发酵", { 跌停家数: { value: 80, confidence: 0.9 } });
    expect(card.env.gear).toBe("防守");
    expect(card.env.reasons.some(r => r.includes("防守触发"))).toBe(true);
    expect(card.stage).toBe("发酵");
  });

  it("映射可以在 YAML 参数里改", () => {
    const card = run("高潮", {}, { 阶段档位: { 高潮: "进攻" } });
    expect(card.env.gear).toBe("进攻");
  });

  it("阶段映射到进攻、但没有主线 → 中性（与三档阈值同一条规则）", () => {
    const card = run("启动", { 主线识别: { value: [], label: "无主线", confidence: 0.85, inputs: { 明细: [] } } });
    expect(card.env.gear).toBe("中性");
    expect(card.env.reasons.some(r => r.includes("没有识别到主线"))).toBe(true);
  });

  it("阶段判不出来 → 沿用三档阈值的档位，卡片不带 stage，并告警", () => {
    const card = run(null);
    expect(card.stage).toBeUndefined();
    expect(card.warnings.some(w => w.includes("情绪阶段"))).toBe(true);
  });

  it("reasons 第一条写出阶段、热度与持续天数", () => {
    const card = run("启动");
    expect(card.env.reasons[0]).toMatch(/情绪阶段 启动（热度 0\.9，持续 4 天） → 进攻/);
    expect(card.env.factors.map(f => f.name)).toContain("情绪阶段");
  });

  it("baseline 择时器的卡片不带 stage 键 —— 对照组形状不变", () => {
    const engine = createV2Engine({ registry: stubRegistry(stubs("高潮")), slots: createSlotRegistry([...BASELINE_SLOTS]) });
    expect("stage" in engine(input())).toBe(false);
  });
});
