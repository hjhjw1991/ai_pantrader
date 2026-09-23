/**
 * 持仓侧的风险预警 —— "什么票风险太高需要抛出"。
 *
 * 纪律线的优先级不动（防守 → 灾难位 → 破止损 → 止盈 …），风险只在其上叠加：
 *   - ST 戴帽直接清仓：结构性风险，与盈亏无关
 *   - 解禁/减持严重、严重超买：原本"持有"的改成"观察"并点名；已触发纪律线的只附注
 */
import { describe, it, expect } from "vitest";
import type { StrategyEngineInput } from "@/lib/contracts";
import { createStrategyEngine } from "@/lib/strategy/engine";
import { createV2Engine, createSlotRegistry, BASELINE_SLOTS } from "@/lib/strategy/v2";
import { makeView, stubRegistry, config, series, sec, quote, type StubValue } from "./helpers";

const DAYS = ["2026-09-17", "2026-09-18", "2026-09-21", "2026-09-22", "2026-09-23"];
const D = "2026-09-23";

const env = (): Record<string, StubValue> => ({
  跌停家数: { value: 5 }, 涨停家数: { value: 60 }, 盘面强度: { value: 80 }, 情绪温度: { value: 65 },
  赚钱效应: { value: 1.5 }, 连板高度: { value: 4 }, 炸板率: { value: 0.1 }, 外围传导: { value: 0.4, label: "中性" },
  主线识别: { value: [], label: "无" },
});

function input(cost: number): StrategyEngineInput {
  return {
    view: makeView({
      asOf: `${D} 15:05:00`, tradingDays: DAYS,
      securities: [sec("600000", "主板")],
      bars: { "600000": series("600000", DAYS, [10, 10, 10, 10, 10]) },
      quotes: { "600000": quote("600000", 10) },
    }),
    config: config(), phase: "盘后",
    positions: [{ account: "卫星账户", code: "600000", cost, qty: 100, stopPx: null }],
  };
}

const holding = (stubs: Record<string, StubValue>, cost = 10) =>
  createStrategyEngine({ registry: stubRegistry({ ...env(), ...stubs }) })(input(cost)).holdings[0];

describe("持仓风险预警", () => {
  it("ST 戴帽 → 清仓，即便浮盈也走", () => {
    const h = holding({ ST状态: { value: 1, label: "ST", confidence: 1 } }, 9);
    expect(h.action).toBe("清仓");
    expect(h.thesis).toMatch(/ST|风险警示/);
  });

  it("ST 未观测（confidence 0）→ 不据此清仓 —— 不知道不等于戴帽", () => {
    const h = holding({ ST状态: { value: 0, label: "未观测", confidence: 0 } });
    expect(h.action).toBe("持有");
  });

  it("解禁压力严重 → 持有改观察，并点名", () => {
    const h = holding({ 解禁压力: { value: 0.2, label: "严重", confidence: 1, inputs: { 最近解禁日: "2026-10-15" } } });
    expect(h.action).toBe("观察");
    expect(h.thesis).toMatch(/解禁/);
  });

  it("减持计划严重 → 持有改观察，并点名", () => {
    const h = holding({ 减持计划: { value: 0.05, label: "严重", confidence: 1 } });
    expect(h.action).toBe("观察");
    expect(h.thesis).toMatch(/减持/);
  });

  it("严重超买 → 持有改观察 —— 可以考虑兑现一部分", () => {
    const h = holding({ 超买超卖: { value: 4, label: "严重超买", confidence: 1 } });
    expect(h.action).toBe("观察");
    expect(h.thesis).toMatch(/超买/);
  });

  it("**已触发纪律线的动作不被覆盖** —— 破止损就是破止损，风险只附注", () => {
    // 成本 12、现价 10 → 浮亏 16.7%，灾难位清仓
    const h = holding({ 解禁压力: { value: 0.2, label: "严重", confidence: 1 } }, 12);
    expect(h.action).toBe("清仓");
    expect(h.thesis).toMatch(/灾难位/);
    expect(h.thesis).toMatch(/解禁/);
  });

  it("预警级（非严重）不改动作 —— 只有越线才动", () => {
    const h = holding({ 解禁压力: { value: 0.06, label: "预警", confidence: 1 } });
    expect(h.action).toBe("持有");
  });

  it("没有风险因子注册时照常出持仓动作 —— 风险是叠加项，不是纪律的前提", () => {
    const h = holding({});
    expect(h.action).toBe("持有");
  });
});

describe("持仓风险：v1 与 v2 一致", () => {
  it("ST 清仓两边一样", () => {
    const stubs = { ...env(), ST状态: { value: 1, label: "ST", confidence: 1 } };
    const v1 = createStrategyEngine({ registry: stubRegistry(stubs) })(input(9));
    const v2 = createV2Engine({ registry: stubRegistry(stubs), slots: createSlotRegistry([...BASELINE_SLOTS]) })(input(9));
    expect(v2.holdings).toEqual(v1.holdings);
  });
});
