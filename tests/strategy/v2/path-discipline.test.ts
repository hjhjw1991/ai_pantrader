/**
 * ⑤ 离场器 · 路径纪律
 *
 * 测的是四条**容易静默做错**的事：
 *   1. 默认不配置任何线条时，装上这个槽**不改变任何判定**（工程款 vs 账户纪律）
 *   2. 配置了线条时能真的触发，并且把「哪条线、第几天」写进 thesis
 *   3. 缺 openDate 时必须告警 + 关掉天数类规则，而不是退化成第 1 天
 *   4. 只能**加重**账户纪律的判定，不能减轻 —— 硬线已判清仓就还是清仓
 */
import { describe, it, expect } from "vitest";
import type { DailyBar, SignalCard, StrategyEngineInput } from "@/lib/contracts";
import type { V2Input } from "@/lib/strategy/v2/engine";
import { createSlotRegistry, createV2Engine, BASELINE_SLOTS } from "@/lib/strategy/v2";
import { 离场器_路径纪律, policyFromSlotParams } from "@/lib/strategy/v2/slots/path-discipline";
import { defaultSlotRegistry } from "@/lib/strategy/v2";
import { makeView, stubRegistry, config, series, sec, quote, type StubValue } from "../helpers";

/** 2026-07-27 起连续 12 个交易日 */
const DAYS = ["2026-07-27", "2026-07-28", "2026-07-29", "2026-07-30", "2026-07-31",
  "2026-08-03", "2026-08-04", "2026-08-05", "2026-08-06", "2026-08-07"];
const TODAY = "2026-08-06";
/** 建仓日置地 DAYS[1]：到 TODAY 共 7 个交易日（含首尾） */
const OPEN = DAYS[1];

function stubs(): Record<string, StubValue> {
  return {
    跌停家数: { value: 5, confidence: 0.9 }, 涨停家数: { value: 60, confidence: 0.9 },
    盘面强度: { value: 80, label: "强", confidence: 0.9 }, 情绪温度: { value: 65, confidence: 0.9 },
    赚钱效应: { value: 1.5, confidence: 0.9 }, 连板高度: { value: 4, confidence: 0.9 },
    炸板率: { value: 0.1, confidence: 0.95 }, 外围传导: { value: 0.4, label: "中性", confidence: 0.8 },
    情绪阶段: { value: 2, label: "发酵", confidence: 0.85 },
    主线识别: { value: ["半导体全链"], label: "半导体全链(必查链)", confidence: 0.85, inputs: { 明细: [] } },
    龙头温度计: { value: 2, label: "封板", confidence: 0.85 },
    过滤器: { value: 0, label: "无否决", confidence: 0.8, inputs: { 通过: [], 否决: [], 未判定: [] } },
    均线方向: { value: 1, label: "多头", confidence: 0.9 }, 量能: { value: 1.4, label: "放量", confidence: 0.9 },
    "洗盘vs派发": { value: 1, label: "洗盘", confidence: 0.7 },
    龙虎榜净买: { value: 1.2e8, label: "净买", confidence: 0.95 },
    游资席位识别: { value: 8e7, label: "游资", confidence: 0.8 },
    结构位: { value: null, label: "无", confidence: 0, inputs: { 阻力: null, 支撑: null } },
    ATR: { value: 0.03, label: "", confidence: 1, inputs: { ATR: 0.3 } },
    ST状态: { value: 0, confidence: 0.9 },
    解禁压力: { value: 0.01, label: "无", confidence: 0.9 },
    减持计划: { value: 0, label: "无", confidence: 0.9 },
    超买超卖: { value: 0, label: "中性", confidence: 0.9 },
  };
}

/**
 * 一条缓慢横盘的走势：价格一直在成本附近，
 * 于是账户纪律的止损（-5%）/止盈（+8%）都不该触发 —— 差异只会来自本槽自己的线。
 */
function bars(): DailyBar[] {
  return series("600183", DAYS, [10, 10.05, 10.1, 10.08, 10.12, 10.06, 10.09, 10.11, 10.07, 10.1])
    .map(b => ({ ...b, o: b.c, h: b.c * 1.002, l: b.c * 0.998, vol: 1e6 }));
}

interface Pos { openDate?: string | null; cost?: number; stopPx?: number | null; code?: string }

function input(f: { slots: unknown; pos?: Pos; positions?: StrategyEngineInput["positions"] }): V2Input {
  const p = f.pos ?? {};
  return {
    view: makeView({
      asOf: `${TODAY} 15:05:00`, tradingDays: DAYS,
      securities: [sec("600183", "主板")],
      bars: { "600183": bars() },
      quotes: { "600183": quote("600183", 10.07) },
    }),
    config: config(),
    phase: "盘后",
    positions: f.positions ?? [{
      account: "卫星账户", code: p.code ?? "600183", cost: p.cost ?? 10, qty: 100,
      stopPx: p.stopPx === undefined ? null : p.stopPx,
      ...(p.openDate !== undefined ? { openDate: p.openDate } : { openDate: OPEN }),
    }],
    // slotConfig 属于 V2Input，不在 StrategyEngineInput 上：引擎靠它挑槽，
    // 而 StrategyEngineInput 是 v1/v2 共用的那层，不该知道槽位这件事
    slotConfig: f.slots as V2Input["slotConfig"],
  };
}

function run(slots: unknown, pos?: Pos): SignalCard {
  const engine = createV2Engine({
    registry: stubRegistry(stubs()),
    slots: createSlotRegistry([...BASELINE_SLOTS, 离场器_路径纪律]),
  });
  return engine(input({ slots, ...(pos === undefined ? {} : { pos }) }));
}

/* --------------------------- ① 默认不打搅任何判定 --------------------------- */

describe("默认不改变行为", () => {
  it("不配置任何线条时，判定与账户纪律一致（持有）", () => {
    const card = run({ 离场器: { 用: "路径纪律" } });
    expect(card.holdings).toHaveLength(1);
    const h = card.holdings[0]!;
    expect(h.action).toBe("持有");
    expect(h.thesis).toContain("未启用任何线条");
  });

  it("给了一个空参数对象也不启用任何线条", () => {
    const card = run({ 离场器: { 用: "路径纪律", 参数: {} } });
    expect(card.holdings[0]!.action).toBe("持有");
  });

  it("0 值不会被当成'当天到期' —— 这是哨兵值最容易出的错", () => {
    const pol = policyFromSlotParams({ 持有上限: 0 });
    expect(pol.到期).toBe(Number.MAX_SAFE_INTEGER);
    expect(pol.破均线).toBeNull();
  });
});

/* ------------------------------ ② 配置了要真能触发 ------------------------------ */

describe("持有上限", () => {
  it("持有 7 个交易日 > 上限 3 → 清仓，并把天数写进 thesis", () => {
    const card = run({ 离场器: { 用: "路径纪律", 参数: { 持有上限: 3 } } });
    const h = card.holdings[0]!;
    expect(h.action).toBe("清仓");
    expect(h.size).toBe(0);
    expect(h.thesis).toContain("期满");
    expect(h.thesis).toContain("第 3 个交易日");   // 上限 3 → 第 3 个交易日收盘期满
  });

  it("上限足够大时不触发", () => {
    const card = run({ 离场器: { 用: "路径纪律", 参数: { 持有上限: 10 } } });
    expect(card.holdings[0]!.action).toBe("持有");
  });
});

describe("破均线", () => {
  it("收盘跌破 MA3 就走", () => {
    // 走一段下行：前几天高、后面低，最后一天收盘低于 MA3
    /**
     * 日内一定要有振幅（h > l）。
     * 全部写成 h==l 的话，下跌日会被正确判成"一字跌停、卖不出去"，规则自然不触发 ——
     * 那不是槽位坏了，是**测试数据不像一段真行情**。
     */
    const down = series("600183", DAYS, [12, 11.6, 11.2, 10.8, 10.5, 10.3, 10.25, 10.2, 10.05, 9.9])
      .map(b => ({ ...b, o: b.c, h: b.c * 1.004, l: b.c * 0.996, vol: 1e6 }));
    const card = createV2Engine({
      registry: stubRegistry(stubs()),
      slots: createSlotRegistry([...BASELINE_SLOTS, 离场器_路径纪律]),
    })({
      ...input({ slots: { 离场器: { 用: "路径纪律", 参数: { 破均线: 3 } } } }),
      view: makeView({
        asOf: `${TODAY} 15:05:00`, tradingDays: DAYS,
        securities: [sec("600183", "主板")],
        bars: { "600183": down },
        quotes: { "600183": quote("600183", 10.05) },
      }),
    });
    expect(card.holdings[0]!.action).toBe("清仓");
    expect(card.holdings[0]!.thesis).toContain("破均线");
  });
});

/* -------------------------- ③ 缺 openDate 必须报出来 -------------------------- */

describe("缺建仓日", () => {
  it("需要天数的规则会告警，且不会退化成第 1 天", () => {
    const card = run(
      { 离场器: { 用: "路径纪律", 参数: { 持有上限: 3 } } },
      { openDate: null },
    );
    expect(card.holdings[0]!.action).toBe("持有");   // 没有天数信息就不许清仓
    expect(card.warnings.some(w => w.includes("缺建仓日") && w.includes("持有上限"))).toBe(true);
  });

  /**
   * 缺建仓日时只能判今天那一根，不许在历史上回放。
   * 早些版本 `from = openDate ?? ""` 让整段 250 根都成了"持有路径"，
   * 下面这段走势在 07-30 破过一次 MA3 —— 那是建仓前的事，却会让今天清仓。
   */
  function runWith(closes: number[], cost: number, params: Record<string, number>): SignalCard {
    const b = series("600183", DAYS, closes)
      .map(x => ({ ...x, o: x.c, h: x.c * 1.004, l: x.c * 0.996, vol: 1e6 }));
    return createV2Engine({
      registry: stubRegistry(stubs()),
      slots: createSlotRegistry([...BASELINE_SLOTS, 离场器_路径纪律]),
    })({
      ...input({ slots: { 离场器: { 用: "路径纪律", 参数: params } }, pos: { openDate: null, cost } }),
      view: makeView({
        asOf: `${TODAY} 15:05:00`, tradingDays: DAYS,
        securities: [sec("600183", "主板")],
        bars: { "600183": b },
        quotes: { "600183": quote("600183", closes[8]!) },
      }),
    });
  }

  it("破均线不会在建仓前的历史K线上触发", () => {
    // 07-30 收 10.2 < MA3(10, 10.5, 11)=10.5 —— 历史上破过；今天 11.2 > MA3(10.6, 10.8, 11.0)
    const card = runWith([10, 10.5, 11, 10.2, 10.4, 10.6, 10.8, 11.0, 11.2, 11.4], 11, { 破均线: 3 });
    const h = card.holdings[0]!;
    expect(h.action).toBe("持有");
    expect(h.thesis).toContain("缺建仓日");
    expect(h.thesis).not.toContain("破均线（");
  });

  it("破均线不需要建仓日：今天收盘跌破照样清仓", () => {
    // 今天 10.5 < MA3(10.6, 10.8, 11.0)=10.8
    const card = runWith([10, 10.5, 11, 10.2, 10.4, 10.6, 10.8, 11.0, 10.5, 10.4], 10.6, { 破均线: 3 });
    const h = card.holdings[0]!;
    expect(h.action).toBe("清仓");
    expect(h.thesis).toContain("破均线");
    expect(h.thesis).toContain(TODAY);
  });

  it("移动止损要从建仓日起算峰值：缺建仓日时关掉并告警", () => {
    // 历史高点 11 → 回撤 3% 的线 10.67；今天 10.5 在线下。不关掉的话会拿建仓前的高点凭空止损
    const card = runWith([10, 10.5, 11, 10.2, 10.4, 10.6, 10.8, 10.6, 10.5, 10.4], 10.6, { 移动止损起: 1, 移动止损回撤: 3 });
    expect(card.holdings[0]!.action).toBe("持有");
    expect(card.warnings.some(w => w.includes("缺建仓日") && w.includes("移动止损"))).toBe(true);
  });
});

/* ------------------------ ④ 只能加重，不能减轻 ------------------------ */

describe("只能加重账户纪律的判定", () => {
  it("灾难位生效时，本槽保持清仓且 thesis 里保留原判定", () => {
    // 同源的坑：这里也必须给振幅，否则下跌日全被判成一字跌停
    const dropBar = series("600183", DAYS, [10, 9.6, 9.2, 9.0, 8.9, 8.85, 8.8, 8.75, 8.7, 8.65])
      .map(b => ({ ...b, o: b.c, h: b.c * 1.004, l: b.c * 0.996, vol: 1e6 }));
    const card = createV2Engine({
      registry: stubRegistry(stubs()),
      slots: createSlotRegistry([...BASELINE_SLOTS, 离场器_路径纪律]),
    })({
      ...input({ slots: { 离场器: { 用: "路径纪律", 参数: { 持有上限: 10 } } } }),
      view: makeView({
        asOf: `${TODAY} 15:05:00`, tradingDays: DAYS,
        securities: [sec("600183", "主板")],
        bars: { "600183": dropBar },
        quotes: { "600183": quote("600183", 8.7) },
      }),
    });
    const h = card.holdings[0]!;
    expect(h.action).toBe("清仓");
    // 硬线来自账户纪律（灾难位 -8%），本槽没有抢功
    expect(h.thesis).toContain("灾难位");
  });
});

/* ------------------------------ 登记 ------------------------------ */

describe("槽位登记", () => {
  it("默认注册表里有它，且 kind/name/version 都对", () => {
    const s = defaultSlotRegistry.get("离场器", "路径纪律");
    expect(s).toBeDefined();
    expect(s!.kind).toBe("离场器");
    expect(s!.version).toBe("1.0.0");
  });

  it("与其他离场器共存，不重名", () => {
    const names = defaultSlotRegistry.list("离场器").map(s => s.name);
    expect(names).toContain("路径纪律");
    expect(names).toContain("账户纪律");
    expect(new Set(names).size).toBe(names.length);
  });
});
