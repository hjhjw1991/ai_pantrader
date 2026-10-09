/**
 * 游资打法槽位。
 *
 * 重点测的是三件**容易静默做错**的事：
 *   1. 触发价按手法与板块走（打板挂涨停价，创业板是 20cm 不是 10cm）
 *   2. 首阴的"收阴缩量"是真的在判，不是永远通过
 *   3. 离场纪律**叠加**在账户纪律之上，不是替换 —— 账户那边判停牌/ST 的逻辑不能丢
 */
import { describe, it, expect } from "vitest";
import type { DailyBar, SignalCard, StrategyEngineInput } from "@/lib/contracts";
import { createV2Engine, createSlotRegistry, BASELINE_SLOTS } from "@/lib/strategy/v2";
import {
  候选源_连板梯队, 评估器_游资手法, 离场器_游资纪律,
} from "@/lib/strategy/v2/slots/hotmoney";
import { makeView, stubRegistry, config, series, sec, zt, quote, type StubValue } from "../helpers";

const DAYS = ["2026-07-28", "2026-07-29", "2026-07-30", "2026-07-31", "2026-08-03"];
const D = "2026-08-03";

function stubs(): Record<string, StubValue> {
  return {
    跌停家数: { value: 5, confidence: 0.9 }, 涨停家数: { value: 60, confidence: 0.9 },
    盘面强度: { value: 80, label: "强", confidence: 0.9 }, 情绪温度: { value: 65, confidence: 0.9 },
    赚钱效应: { value: 1.5, confidence: 0.9 }, 连板高度: { value: 4, confidence: 0.9 },
    炸板率: { value: 0.1, confidence: 0.95 }, 外围传导: { value: 0.4, label: "中性", confidence: 0.8 },
    情绪阶段: { value: 2, label: "发酵", confidence: 0.85, inputs: { 热度: 60, 持续天数: 3 } },
    主线识别: { value: ["半导体全链"], label: "半导体全链(必查链)", confidence: 0.85,
      inputs: { 明细: [{ name: "半导体全连", sectors: ["半导体"] }] } },
    龙头温度计: { value: 2, label: "封板", confidence: 0.85 },
    过滤器: { value: 0, label: "无否决", confidence: 0.8,
      inputs: { 通过: ["位置", "换手振幅"], 否决: [], 未判定: [] } },
    均线方向: { value: 1, label: "多头", confidence: 0.9 }, 量能: { value: 1.4, label: "放量", confidence: 0.9 },
    "洗盘vs派发": { value: 1, label: "洗盘", confidence: 0.7 },
    龙虎榜净买: { value: 1.2e8, label: "净买", confidence: 0.95 },
    游资席位识别: { value: 8e7, label: "游资", confidence: 0.8 },
    结构位: { value: null, label: "无", confidence: 0,
      inputs: { 阻力: null, 支撑: null } },
    ATR: { value: 0.03, label: "", confidence: 1, inputs: { ATR: 0.3 } },
  };
}

/** 把 series 生成的收盘价补成带开高低量的完整日线（首阴与炸板判定要用） */
function withOHLC(code: string, closes: number[], over: Array<Partial<DailyBar>> = []): DailyBar[] {
  return series(code, DAYS, closes).map((b, i) => ({
    ...b, o: closes[i], h: closes[i], l: closes[i], vol: 1e6, ...(over[i] ?? {}),
  }));
}

interface Fix {
  bars?: Record<string, DailyBar[]>;
  zt?: Array<{ code: string; lbc: number; sealAmt: number; sector: string }>;
  positions?: StrategyEngineInput["positions"];
}

function input(f: Fix = {}): StrategyEngineInput {
  return {
    view: makeView({
      asOf: `${D} 15:05:00`, tradingDays: DAYS,
      securities: [sec("600183", "主板"), sec("300750", "创业板")],
      bars: f.bars ?? {
        "600183": withOHLC("600183", [10, 10.2, 10.5, 10.8, 11]),
        "300750": withOHLC("300750", [20, 20.4, 21, 21.5, 22]),
      },
      quotes: { "600183": quote("600183", 11), "300750": quote("300750", 22) },
      zt: { [D]: (f.zt ?? []).map(x => zt(D, x.code, { sector: x.sector, lbc: x.lbc, sealAmt: x.sealAmt })) },
    }),
    config: config(), phase: "盘后", positions: f.positions ?? [],
  };
}

function run(slotConfig: unknown, fix: Fix = {}): SignalCard {
  const engine = createV2Engine({
    registry: stubRegistry(stubs()),
    slots: createSlotRegistry([...BASELINE_SLOTS, 候选源_连板梯队, 评估器_游资手法, 离场器_游资纪律]),
  });
  return engine({ ...input(fix), slotConfig: slotConfig as any });
}

/* ------------------------------- 候选源 ------------------------------- */

describe("候选源·连板梯队", () => {
  const pool = [
    { code: "600183", lbc: 1, sealAmt: 1e8, sector: "半导体" },
    { code: "300750", lbc: 2, sealAmt: 5e7, sector: "半导体" },
  ];

  it("按板数区间过滤：1~2 板留两只，2~2 板只留 2 板", () => {
    const wide = run({ 候选源: [{ 用: "连板梯队", 参数: { 板数下限: 1, 板数上限: 2 } }] }, { zt: pool });
    const narrow = run({ 候选源: [{ 用: "连板梯队", 参数: { 板数下限: 2, 板数上限: 2 } }] }, { zt: pool });
    expect(wide.candidates.map(c => c.code).sort()).toEqual(["300750", "600183"]);
    expect(narrow.candidates.map(c => c.code)).toEqual(["300750"]);
  });

  it("区间外的票不进池（4 板不在 1~2 板区间）", () => {
    const r = run({ 候选源: [{ 用: "连板梯队", 参数: { 板数下限: 1, 板数上限: 2 } }] },
      { zt: [{ code: "600183", lbc: 4, sealAmt: 1e8, sector: "半导体" }] });
    expect(r.candidates).toHaveLength(0);
  });

  it("只要龙头：同一板块只留连板最高的一只", () => {
    const r = run({
      候选源: [{ 用: "连板梯队", 参数: { 板数下限: 1, 板数上限: 9, 只要龙头: true } }],
    }, { zt: pool });
    expect(r.candidates.map(c => c.code)).toEqual(["300750"]);   // 2 板压过 1 板
    expect(r.candidates[0].thesis).toContain("龙头");
  });

  it("板数区间外为空时告警，不静默返回空池", () => {
    const r = run({ 候选源: [{ 用: "连板梯队", 参数: { 板数下限: 8, 板数上限: 9 } }] }, { zt: pool });
    expect(r.candidates).toHaveLength(0);
    expect(r.warnings.some(w => w.includes("连板梯队"))).toBe(true);
  });
});

/* ------------------------------- 评估器 ------------------------------- */

describe("评估器·游资手法", () => {
  const zt1 = [{ code: "600183", lbc: 1, sealAmt: 1e8, sector: "半导体" }];

  const cand = (slotConfig: unknown, fix: Fix = {}) =>
    run(slotConfig, { zt: zt1, ...fix }).candidates[0];

  it("打板：触发价 = 昨收 ×(1+限幅)，主板 10cm", () => {
    // 600183 昨收 11 → 涨停价 12.10
    const c = cand({ 评估器: { 用: "游资手法", 参数: { 手法: "打板" } } });
    expect(c).toBeDefined();
    expect(c!.triggerPx).toBe(12.1);
    expect(c!.thesis).toContain("打板");
  });

  it("打板：创业板按 20cm 算，不是套用主板的 10%", () => {
    const c = cand({ 评估器: { 用: "游资手法", 参数: { 手法: "打板" } } },
      { zt: [{ code: "300750", lbc: 1, sealAmt: 1e8, sector: "半导体" }] });
    expect(c!.triggerPx).toBe(26.4);      // 22 × 1.20
  });

  it("半路默认 +5%，低吸默认 −3%（与 YAML 同值，便于对照）", () => {
    const half = cand({ 评估器: { 用: "游资手法", 参数: { 手法: "半路" } } });
    const low = cand({ 评估器: { 用: "游资手法", 参数: { 手法: "低吸" } } });
    expect(half!.triggerPx).toBe(11.55);  // 11 × 1.05
    expect(low!.triggerPx).toBe(10.67);   // 11 × 0.97
  });

  it("手法写错回落低吸并告警，不静默按未知手法处理", () => {
    const r = run({ 评估器: { 用: "游资手法", 参数: { 手法: "梭哈" } } }, { zt: zt1 });
    expect(r.warnings.some(w => w.includes("无法解释"))).toBe(true);
    expect(r.candidates[0].triggerPx).toBe(10.67);
  });

  it("首阴：昨日收阳 → 不成立；收阴且缩量 → 成立且触发价不高于 MA5", () => {
    const 阳线 = cand({ 评估器: { 用: "游资手法", 参数: { 手法: "首阴" } } },
      { bars: { "600183": withOHLC("600183", [10, 10.2, 10.5, 10.8, 11]) } });
    expect(阳线).toBeUndefined();   // 默认夹具 o == c，不收阴

    const 阴线缩量 = cand({ 评估器: { 用: "游资手法", 参数: { 手法: "首阴" } } }, {
      bars: {
        "600183": withOHLC("600183", [10, 10.5, 10.8, 11.2, 11],
          [{}, {}, {}, {}, { o: 11.6, c: 11, vol: 5e5 }]),
      },
    });
    expect(阴线缩量).toBeDefined();
    // MA5 = (10+10.5+10.8+11.2+11)/5 = 10.70；11 × 0.95 = 10.45 → 取 min = 10.45
    expect(阴线缩量!.triggerPx).toBeLessThanOrEqual(10.7);
    expect(阴线缩量!.thesis).toContain("不高于 MA5");
  });

  it("首阴：收阴但放量 → 不成立（放量分歧不是洗盘）", () => {
    const c = cand({ 评估器: { 用: "游资手法", 参数: { 手法: "首阴" } } }, {
      bars: {
        "600183": withOHLC("600183", [10, 10.5, 10.8, 11.2, 11],
          [{}, {}, {}, {}, { o: 11.6, c: 11, vol: 9e6 }]),
      },
    });
    expect(c).toBeUndefined();
  });

  it("不高于MA5 可独立于手法开启：低吸也贴着 MA5 接", () => {
    // 11 × 0.97 = 10.67；MA5 = (10+10.2+10.5+10.8+11)/5 = 10.50 → 取 min = 10.50
    const c = cand({ 评估器: { 用: "游资手法", 参数: { 手法: "低吸", 不高于MA5: true } } });
    expect(c!.triggerPx).toBe(10.5);
    expect(c!.thesis).toContain("不高于 MA5");
  });

  /**
   * 容差这一档是回放逼出来的：严格版 min(昨收, MA5) 触发率只剩 7.8%，
   * 单笔质量确实升了但一年攒不出 43 笔。所以要有"贴着即可、不必跌破"。
   * 这里的断言重点是**三档必须严格递增** —— 若哪天写反了（比如把容差乘到
   * 昨收上而不是 MA5 上），数字照样出得来，但方向就错了。
   */
  it("MA5 容差：true 压到 MA5，数字压到 MA5×倍数，放开即不压（严格递增）", () => {
    // 强趋势：昨收 11 → base = 11×0.97 = 10.67；MA5 = (8+8.5+9+9.5+11)/5 = 9.2
    const fix: Fix = { bars: { "600183": withOHLC("600183", [8, 8.5, 9, 9.5, 11]) } };
    const px = (不高于MA5: unknown) => cand(
      { 评估器: { 用: "游资手法", 参数: { 手法: "低吸", 沿用默认筛: true, 不高于MA5 } } }, fix)?.triggerPx;

    const strict = px(true);
    const l103 = px(1.03);
    const l106 = px(1.06);
    const free = px(false);

    expect(strict).toBe(9.2);      // min(10.67, 9.2)
    expect(l103).toBe(9.48);       // min(10.67, 9.2×1.03)
    expect(l106).toBe(9.75);       // min(10.67, 9.2×1.06)
    expect(free).toBe(10.67);      // 完全不压
    expect(strict!).toBeLessThan(l103!);
    expect(l103!).toBeLessThan(l106!);
    expect(l106!).toBeLessThan(free!);
  });

  it("容差档在 thesis 上留痕：一看就知道这张卡是按 MA5×1.03 出的", () => {
    const fix: Fix = { bars: { "600183": withOHLC("600183", [8, 8.5, 9, 9.5, 11]) } };
    const c = cand({ 评估器: { 用: "游资手法", 参数: { 手法: "低吸", 沿用默认筛: true, 不高于MA5: 1.03 } } }, fix);
    expect(c!.thesis).toContain("MA5×1.03");
    // 严格档不能把自己说成带容差
    const s = cand({ 评估器: { 用: "游资手法", 参数: { 手法: "低吸", 沿用默认筛: true, 不高于MA5: true } } }, fix);
    expect(s!.thesis).toContain("不高于 MA5");
    expect(s!.thesis).not.toContain("×1.03");
  });

  it("沿用默认筛：不放宽且在 thesis 上没有放宽痕迹（单变量对照的前提）", () => {
    const clean = cand({ 评估器: { 用: "游资手法", 参数: { 手法: "低吸", 沿用默认筛: true } } });
    const loose = cand({ 评估器: { 用: "游资手法", 参数: { 手法: "低吸" } } });
    expect(clean!.thesis).not.toContain("放宽筛");
    expect(loose!.thesis).toContain("放宽筛");
    // 筛口不同，但触发价算法相同 —— 差别必须只落在"哪些票有资格进池"
    expect(clean!.triggerPx).toBe(loose!.triggerPx);
  });

  it("止损按参数覆写，不再沿用账户的 −10%", () => {
    const c = cand({ 评估器: { 用: "游资手法", 参数: { 手法: "低吸", 止损: -0.08 } } });
    expect(c!.stopPx).toBe(9.82);   // 10.67 × 0.92
    expect(c!.thesis).toContain("硬止损");
  });

  it("最低盈亏比门槛生效：门槛抬高到不可能时不出候选", () => {
    const loose = cand({ 评估器: { 用: "游资手法", 参数: { 手法: "低吸", 最低盈亏比: 0.5 } } });
    const strict = cand({ 评估器: { 用: "游资手法", 参数: { 手法: "低吸", 最低盈亏比: 99 } } });
    expect(loose).toBeDefined();
    expect(strict).toBeUndefined();
  });
});

/* ------------------------------- 离场器 ------------------------------- */

describe("离场器·游资纪律", () => {
  const pos = (cost: number) => [{ account: "hj-main" as const, code: "600183" as const, cost, qty: 1000, stopPx: null }];

  const holding = (params: Record<string, unknown>, fix: Fix) =>
    run({ 离场器: { 用: "游资纪律", 参数: params } }, fix).holdings[0];

  it("浮亏触及硬止损 → 清仓", () => {
    // 昨收 11，成本 13 → 浮亏 −15.4%
    const h = holding({ 止损: -0.08 }, { positions: pos(13) });
    expect(h.action).toBe("清仓");
    expect(h.thesis).toContain("硬止损");
  });

  it("未触及止损 → 沿用账户纪律，不擅自改动作", () => {
    const h = holding({ 止损: -0.08 }, { positions: pos(11.2) });
    expect(h.action).not.toBe("清仓");
    expect(h.thesis).toContain("游资纪律未触发");
  });

  it("跌破 MA5 → 清仓（MA5 = 10.70，收盘 10.5）", () => {
    const h = holding({ 止损: -0.5, 破线: "MA5" }, {
      positions: pos(10.4),
      bars: { "600183": withOHLC("600183", [10, 10.5, 10.8, 11.2, 10.5]) },
    });
    expect(h.action).toBe("清仓");
    expect(h.thesis).toContain("MA5");
  });

  it("炸板未封 → 清仓（触板 12.10 却收在 11.5）", () => {
    const h = holding({ 止损: -0.5, 破线: null }, {
      positions: pos(10),
      bars: {
        "600183": withOHLC("600183", [10, 10.2, 10.5, 11, 11.5],
          [{}, {}, {}, {}, { h: 12.1, c: 11.5, o: 11, l: 11 }]),
      },
    });
    expect(h.action).toBe("清仓");
    expect(h.thesis).toContain("炸板");
  });

  /**
   * 叠加只许加严、不许放松：账户纪律已经判了清仓，游资纪律哪条都没触发，
   * 结果也必须还是清仓 —— 不能因为"游资纪律未触发"就把 baseline 的离场吞掉。
   */
  it("账户纪律已判清仓、游资纪律未触发 → 仍是清仓", () => {
    // 卫星账户（测试配置：止损 −5%、灾难位 −8%）。昨收 11，成本 13 → 浮亏 −15.4%，穿了灾难位；
    // 游资这边把三条都放开，确保清仓只可能来自账户纪律
    const h = holding({ 止损: -0.5, 破线: null, 炸板走: false },
      { positions: [{ account: "卫星账户", code: "600183", cost: 13, qty: 1000, stopPx: null }] });
    expect(h.action).toBe("清仓");
    expect(h.thesis).toContain("游资纪律未触发");
  });

  it("破线: null 关掉破线离场；不写则默认 MA5", () => {
    const fix = {
      positions: pos(10.4),
      bars: { "600183": withOHLC("600183", [10, 10.5, 10.8, 11.2, 10.5]) },   // 收 10.5 < MA5 10.70
    };
    const off = holding({ 止损: -0.5, 破线: null, 炸板走: false }, fix);
    expect(off.action).not.toBe("清仓");
    expect(off.thesis).not.toContain("跌破");
    const dflt = holding({ 止损: -0.5, 炸板走: false }, fix);
    expect(dflt.action).toBe("清仓");
    expect(dflt.thesis).toContain("跌破MA5");
  });

  it("止盈到位 → 清仓", () => {
    const h = holding({ 止损: -0.5, 止盈: 0.03, 破线: null }, { positions: pos(10.5) });
    // 11 / 10.5 − 1 = +4.76%
    expect(h.action).toBe("清仓");
    expect(h.thesis).toContain("止盈");
  });
});
