/**
 * 槽位到底是不是插槽。
 *
 * parity 证明的是"v2 能当 baseline"，这里证明的是另一半：**换掉一个槽，行为真的会变，
 * 而护栏一步不退**。两件事都成立，"多策略影子盘"才有意义 ——
 * 否则要么对照组不可信，要么根本换不出第二套策略。
 */
import { describe, it, expect } from "vitest";
import type { SignalCard, StrategyEngineInput } from "@/lib/contracts";
import { validateStrategyYaml } from "@/lib/strategy/schema";
import {
  createV2Engine, createSlotRegistry, BASELINE_SLOTS, 评估器_可配权重打分,
} from "@/lib/strategy/v2";
import {
  makeView, stubRegistry, config, series, sec, zt, quote, BASE_YAML, type StubValue,
} from "../helpers";

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
      inputs: { 明细: [{ name: "半导体全链", sectors: ["半导体"] }] },
    },
    龙头温度计: { value: 2, label: "封板", confidence: 0.85 },
    过滤器: {
      value: 0, label: "七道筛无否决", confidence: 5 / 7,
      inputs: { 通过: ["位置", "换手振幅"], 否决: [], 未判定: ["估值基本面", "催化真伪"] },
    },
    均线方向: { value: 1, label: "多头", confidence: 0.9 },
    量能: { value: 1.4, label: "放量", confidence: 0.9 },
    "洗盘vs派发": { value: 1, label: "洗盘", confidence: 0.7 },
    龙虎榜净买: { value: 1.2e8, label: "净买 1.2 亿", confidence: 0.95 },
    游资席位识别: { value: 8e7, label: "游资净买", confidence: 0.8 },
    ...over,
  };
}

/**
 * 两只票刻意造成"资金面差距大、形态面完全相同"：
 * 600183 三板 + 2 亿封单，300750 首板 + 5000 万封单，其余因子读数一致。
 * 于是只要把打分权重从资金面挪到形态面，两者的名次就必然互换 ——
 * 这正是用来证明"换了槽真的换了行为"的那把尺子。
 */
function input(over: Partial<StrategyEngineInput> = {}): StrategyEngineInput {
  return {
    view: makeView({
      asOf: `${D} 15:05:00`,
      tradingDays: DAYS,
      securities: [sec("600183", "主板"), sec("300750", "创业板")],
      bars: {
        "600183": series("600183", DAYS, [10, 10.2, 10.5, 10.8, 11]),
        "300750": series("300750", DAYS, [20, 20.4, 21, 21.5, 22]),
      },
      quotes: { "600183": quote("600183", 11), "300750": quote("300750", 22) },
      zt: {
        [D]: [
          zt(D, "600183", { sector: "半导体", lbc: 3, sealAmt: 2e8 }),
          zt(D, "300750", { sector: "半导体", lbc: 1, sealAmt: 5e7 }),
        ],
      },
    }),
    config: over.config ?? config(),
    phase: "盘后",
    positions: [],
  };
}

function runV2(over: Partial<StrategyEngineInput> = {}, slotConfig?: any): SignalCard {
  const engine = createV2Engine({
    registry: stubRegistry(stubs()),
    slots: createSlotRegistry([...BASELINE_SLOTS, 评估器_可配权重打分]),
  });
  return engine({ ...input(over), slotConfig });
}

describe("换掉评估器，排序真的会变", () => {
  it("baseline：资金面权重高，三板 2 亿封单的排在前面", () => {
    const card = runV2();
    expect(card.candidates.map(c => c.code)).toEqual(["600183", "300750"]);
  });

  it("换成可配权重打分 + 权重全挪到形态面：名次互换", () => {
    const card = runV2({}, {
      评估器: { 用: "可配权重打分", 参数: { 权重: { 连板: 0, 封单: 0, 均线: 0.4, 量能: 0.3, 龙虎榜: 0.3 } } },
    });
    // 两只票的形态因子读数完全相同 → 打平 → 按代码升序，300750 反超
    expect(card.candidates.map(c => c.code)).toEqual(["300750", "600183"]);
  });

  it("可配权重打分不配参数时，打分与 baseline 逐位相同 —— 它是纯替换，不是顺手改行为", () => {
    const a = runV2();
    const b = runV2({}, { 评估器: { 用: "可配权重打分" } });
    expect(b.candidates.map(c => c.score)).toEqual(a.candidates.map(c => c.score));
  });

  it("权重合计不为 1 时告警 —— 多半是漏写一项或小数点错位，而它只表现为「排序怪怪的」", () => {
    const card = runV2({}, {
      评估器: { 用: "可配权重打分", 参数: { 权重: { 连板: 0.5, 封单: 0.5, 均线: 0.5, 量能: 0.5, 龙虎榜: 0.5 } } },
    });
    expect(card.warnings.some(w => w.includes("打分权重合计"))).toBe(true);
  });
});

describe("组合风控不可插拔", () => {
  it("换任何槽都绕不过单票上限 —— 护栏若能被策略自己换掉，影子盘里它赢的就是风控不是别人", () => {
    for (const sc of [
      undefined,
      { 评估器: { 用: "可配权重打分", 参数: { 权重: { 连板: 1, 封单: 1, 均线: 1, 量能: 1, 龙虎榜: 1 } } } },
    ]) {
      const card = runV2({}, sc);
      expect(card.candidates.length).toBeGreaterThan(0);
      for (const c of card.candidates) expect(c.size).toBeLessThanOrEqual(0.15);
    }
  });

  it("YAML 的 槽位 段里没有「风控」这一项 —— 想换也无处可写", () => {
    const r = validateStrategyYaml(`${BASE_YAML}槽位:\n  风控: { 用: 无上限 }\n`);
    expect(r.ok).toBe(true);
    // looseObject 不会因未知键报错，但它也不会被引擎读到：风控永远走固定实现
    const card = runV2({ config: (r as any).config });
    for (const c of card.candidates) expect(c.size).toBeLessThanOrEqual(0.15);
  });
});

describe("槽位写在 YAML 里", () => {
  it("YAML 的 槽位 段能被解析并生效，不必从代码传", () => {
    const yaml = `${BASE_YAML}槽位:\n` +
      `  评估器: { 用: 可配权重打分, 参数: { 权重: { 连板: 0, 封单: 0, 均线: 0.4, 量能: 0.3, 龙虎榜: 0.3 } } }\n`;
    const r = validateStrategyYaml(yaml);
    expect(r.ok).toBe(true);
    const card = runV2({ config: (r as any).config });
    expect(card.candidates.map(c => c.code)).toEqual(["300750", "600183"]);
  });

  it("显式入参优先于 YAML —— 影子盘要拿同一份 YAML 跑多套槽组合，不能为此改用户的策略文件", () => {
    const yaml = `${BASE_YAML}槽位:\n` +
      `  评估器: { 用: 可配权重打分, 参数: { 权重: { 连板: 0, 封单: 0, 均线: 0.4, 量能: 0.3, 龙虎榜: 0.3 } } }\n`;
    const r = validateStrategyYaml(yaml);
    const card = runV2({ config: (r as any).config }, { 评估器: { 用: "七道筛打分" } });
    expect(card.candidates.map(c => c.code)).toEqual(["600183", "300750"]);
  });

  it("候选源配成空数组直接报错 —— 全关掉的策略每天零候选，却会凭「从不亏钱」赢下排行榜", () => {
    const r = validateStrategyYaml(`${BASE_YAML}槽位:\n  候选源: []\n`);
    expect(r.ok).toBe(false);
    expect((r as any).issues.some((i: any) => i.message.includes("候选源不可为空数组"))).toBe(true);
  });

  it("槽位必须指名用哪份实现", () => {
    const r = validateStrategyYaml(`${BASE_YAML}槽位:\n  评估器: { 参数: { 权重: {} } }\n`);
    expect(r.ok).toBe(false);
  });
});
