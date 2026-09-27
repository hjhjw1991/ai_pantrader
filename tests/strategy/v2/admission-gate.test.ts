/**
 * 准入闸门（择时.开仓档位 / 择时.开仓阶段）。
 *
 * 2026-09-27 加。它补的是一个真实的缺口：**仓位档位管的是"买多少"，管不了"要不要买"**。
 * 中性档 40% 仓位照样会开新仓，而回放里中性档开出来的仓正是拉低期望的那一批
 * （baseline 变体 -3% 折让：不限档位 +0.36%/日，只留进攻档 +0.53%/日）。
 *
 * 两条边界必须守住，各有一条测试：
 *   1. 不配 = 不限制。v2 与 v1 的 parity 建立在这个前提上，闸门一旦默认生效，
 *      影子盘的对照组就和历史口径对不上，"打赢 baseline" 这句话随之失效。
 *   2. 判不出阶段 ≠ 通过。配了 开仓阶段 而择时器不判阶段时按"没查清"处理，
 *      静默放行等于宣称"查过阶段了"，那是最危险的假阳性。
 */
import { describe, it, expect } from "vitest";
import { createV2Engine, createSlotRegistry, BASELINE_SLOTS } from "@/lib/strategy/v2";
import { validateStrategyYaml } from "@/lib/strategy/schema";
import { type StrategyEngineInput } from "@/lib/contracts";
import { makeView, stubRegistry, config, series, sec, zt, quote, type StubValue } from "../helpers";

const DAYS = ["2026-07-28", "2026-07-29", "2026-07-30", "2026-07-31", "2026-08-03"];
const D = "2026-08-03";

function stubs(over: Record<string, StubValue> = {}): Record<string, StubValue> {
  return {
    跌停家数: { value: 5, confidence: 0.9 },
    涨停家数: { value: 60, confidence: 0.9 },
    盘面强度: { value: 80, label: "强", confidence: 0.9 },
    情绪温度: { value: 65, confidence: 0.9 },
    赚钱效应: { value: 1.5, confidence: 0.9 },
    连板高度: { value: 4, confidence: 0.9 },
    炸板率: { value: 0.1, confidence: 0.95 },
    外围传导: { value: 0.4, label: "中性", confidence: 0.8 },
    主线识别: {
      value: ["半导体全链"], label: "半导体全链(必查链)", confidence: 0.85,
      inputs: { 明细: [{ name: "半导体全链", leaderCode: "600183", maxLbc: 3, sectors: ["半导体"] }] },
    },
    龙头温度计: { value: 2, label: "封板", confidence: 0.85 },
    过滤器: {
      value: 0, label: "七道筛无否决", confidence: 5 / 7,
      inputs: { 通过: ["位置", "换手振幅"], 否决: [], 未判定: ["估值基本面"] },
    },
    均线方向: { value: 1, label: "多头", confidence: 0.9 },
    量能: { value: 1.4, label: "放量", confidence: 0.9 },
    "洗盘vs派发": { value: 1, label: "洗盘", confidence: 0.7 },
    龙虎榜净买: { value: 1.2e8, label: "净买 1.2 亿", confidence: 0.95 },
    游资席位识别: { value: 8e7, label: "游资净买", confidence: 0.8 },
    ...over,
  };
}

/** 没有主线 → baseline 三档阈值择时器判为中性档 */
const 中性stub = { 主线识别: { value: [], label: "无主线", confidence: 0.5 } };

function run(over: Partial<StrategyEngineInput> = {}, cfgMutate: (y: string) => string = s => s, s: Record<string, StubValue> = {}) {
  const input: StrategyEngineInput = {
    view: makeView({
      asOf: `${D} 15:05:00`,
      tradingDays: DAYS,
      securities: [sec("600183", "主板")],
      bars: { "600183": series("600183", DAYS, [10, 10.2, 10.5, 10.8, 11]) },
      quotes: { "600183": quote("600183", 11) },
      zt: { [D]: [zt(D, "600183", { sector: "半导体", lbc: 3, sealAmt: 2e8 })] },
      sectors: { [D]: [{ date: D, ts: `${D} 14:55:00`, sector: "半导体", pct: 6.1, rank: 1, leaderCode: "600183", leaderPct: 10 } as any] },
    }),
    config: config(cfgMutate),
    phase: "盘后",
    positions: [],
    ...over,
  };
  return createV2Engine({ registry: stubRegistry(stubs(s)), slots: createSlotRegistry([...BASELINE_SLOTS]) })(input);
}

const withGate = (line: string) => (y: string) => y.replace("  防守触发:", `${line}\n  防守触发:`);

describe("准入闸门：不配就是不限制", () => {
  it("没写 开仓档位 → 中性档照样出候选（parity 的前提，改默认会毁掉对照组）", () => {
    const card = run({}, s => s, 中性stub);
    expect(card.env.gear).toBe("中性");
    expect(card.warnings.some(w => w.includes("准入闸门"))).toBe(false);
  });
});

describe("准入闸门：开仓档位", () => {
  it("配了只准进攻 → 中性档不出候选，并把原因写在卡片上", () => {
    const card = run({}, withGate("  开仓档位: [进攻]"), 中性stub);
    expect(card.env.gear).toBe("中性");
    expect(card.candidates).toEqual([]);
    expect(card.warnings.some(w => w.includes("准入闸门") && w.includes("不在准入档位"))).toBe(true);
  });

  it("进攻档照常出候选 —— 闸门只挡不合档的日子", () => {
    const card = run({}, withGate("  开仓档位: [进攻]"));
    expect(card.env.gear).toBe("进攻");
    expect(card.candidates.length).toBeGreaterThan(0);
    expect(card.warnings.some(w => w.includes("准入闸门"))).toBe(false);
  });

  it("已有持仓仍给离场判断 —— 闸门只管开新仓，不管处置老仓", () => {
    const card = run(
      { positions: [{ account: "卫星账户", code: "600183", cost: 12, qty: 100, stopPx: null }] },
      withGate("  开仓档位: [进攻]"), 中性stub
    );
    expect(card.candidates).toEqual([]);
    expect(card.holdings).toHaveLength(1);
  });
});

describe("准入闸门：开仓阶段（未判定不等于通过）", () => {
  it("配了阶段、但择时器判不出阶段 → 不开仓并告警，不静默放行", () => {
    // baseline 三档阈值择时器不判情绪阶段，card.stage 为 undefined
    const card = run({}, withGate("  开仓阶段: [启动, 发酵]"));
    expect(card.stage).toBeUndefined();
    expect(card.candidates).toEqual([]);
    expect(card.warnings.some(w => w.includes("没判出情绪阶段"))).toBe(true);
  });
});

describe("准入闸门：配置校验", () => {
  const bad = (line: string) => {
    const r = validateStrategyYaml(
      `id: x\nversion: 1.0.0\n择时:\n  仓位档位: { 进攻: 0.7, 中性: 0.4, 防守: 0.0 }\n${line}\n  防守触发: {}\n`, "t.yaml");
    // zod 的元素级报错 message 里不带键名（只有 "Invalid option"），所以连 path 一起看：
    // 报错必须定位到是哪一行配错了，否则人面对几十行 YAML 只能逐行猜
    return r.ok ? null : r.issues.map(i => `${i.path.join(".")}｜${i.message}`).join("；");
  };

  it("空数组挡掉 —— 那等于永远不开仓，是关掉系统不是配策略", () => {
    expect(bad("  开仓档位: []")).toMatch(/永远不开仓/);
  });

  it("档位字面量写错当场报错，不静默忽略", () => {
    expect(bad("  开仓档位: [猛攻]")).toMatch(/开仓档位/);
  });

  it("阶段字面量写错当场报错", () => {
    expect(bad("  开仓阶段: [起飞]")).toMatch(/开仓阶段/);
  });
});
