import { describe, it, expect } from "vitest";
import { createStrategyEngine } from "@/lib/strategy/engine";
import { makeView, sec, series, zt, quote, stubRegistry, type StubValue } from "./helpers";
import { parseStrategy } from "@/lib/strategy/loader";
import fs from "node:fs";
import path from "node:path";

/**
 * 候选池的三路来源。
 *
 * 起因：候选原本**只**从涨停池选。入场手法是回踩低吸（触发价 = min(昨收, MA5)，
 * 从不按涨停价追），但标的池的人口结构却是打板股 —— 主线里没涨停、形态更好的票
 * 永远进不来，排序又按"连板数 → 封单额"，进一步偏向情绪票。
 *
 * 现在三路汇流，但**都要过同一道主线筛与七道筛**：
 *   涨停池   昨日涨停
 *   主线领涨 主线板块涨幅榜上的领涨股
 *   量价     主线板块成分里放量突破 + 均线多头排列的
 *
 * "只做主线"这条纪律对三路一视同仁 —— 这正是这组测试要钉住的。
 */

/**
 * 25 个交易日：多头排列要算 MA20，夹具短于 20 根的话量价那一路**永远**返回 false，
 * 测出来的会是"夹具太短"而不是"条件对不对"。
 * 顺带这也钉住一条真实行为：上市不足 20 个交易日的新股进不了量价这一路 —— 趋势无从判断。
 */
const DAYS = Array.from({ length: 25 }, (_, i) => {
  const d = new Date(Date.UTC(2026, 6, 1) + i * 86_400_000);
  return d.toISOString().slice(0, 10);
});
const D = DAYS[DAYS.length - 1];

const YAML = fs.readFileSync(
  path.join(process.cwd(), "config/strategies/default.yaml.example"), "utf8"
);
const baseConfig = () => parseStrategy(YAML).config!;

function stubs(over: Record<string, StubValue> = {}): Record<string, StubValue> {
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
      value: 0, label: "七道筛无否决", confidence: 1,
      inputs: { 通过: ["位置", "换手振幅"], 否决: [], 未判定: [] },
    },
    均线方向: { value: 1, label: "多头", confidence: 0.9 },
    量能: { value: 1.4, label: "放量", confidence: 0.9 },
    洗盘vs派发: { value: 1, label: "洗盘", confidence: 0.8 },
    龙虎榜净买: { value: 1e7, confidence: 0.9 },
    游资席位识别: { value: 1, label: "知名游资", confidence: 0.8 },
    ...over,
  };
}

/** 一只放量突破 + 多头排列的票：量能逐日抬升、收盘创新高、均线多头 */
const 强势序列 = (code: string) => {
  const closes = DAYS.map((_, i) => 10 + i * 0.12);          // 稳步上行 → 均线多头、末根创新高
  const bars = series(code, DAYS, closes);
  return bars.map((b, i) => ({ ...b, vol: i === bars.length - 1 ? 5_000_000 : 1_000_000 }));
};
/** 一只缩量阴跌的票：不该被量价那一路选中 */
const 弱势序列 = (code: string) => {
  const closes = DAYS.map((_, i) => 12 - i * 0.06);          // 缩量阴跌 → 两条都不满足
  const bars = series(code, DAYS, closes);
  return bars.map(b => ({ ...b, vol: 1_000_000 }));
};

function build(over: {
  sources?: Record<string, boolean>;
  sectorOf?: (c: string) => string | null;
  sectorMapAt?: string;
} = {}) {
  const view = makeView({
    asOf: D,
    tradingDays: DAYS,
    securities: [sec("600183", "主板"), sec("600900", "主板"), sec("600999", "主板")],
    bars: {
      "600183": series("600183", DAYS, DAYS.map((_, i) => 10 + i * 0.04)),
      "600900": 强势序列("600900"),
      "600999": 弱势序列("600999"),
    },
    quotes: {
      "600183": quote("600183", 11), "600900": quote("600900", 13), "600999": quote("600999", 10.5),
    },
    zt: { [D]: [zt(D, "600183", { sector: "半导体", lbc: 3 })] },
    sectors: {
      [D]: [
        { date: D, ts: `${D} 15:00:00.000`, sector: "半导体", pct: 5.2, leaderCode: "600900" },
        { date: D, ts: `${D} 15:00:00.000`, sector: "白酒", pct: 4.9, leaderCode: "600519" },
      ],
    },
  });
  const cfg = baseConfig();
  const config = {
    ...cfg,
    选股: { ...cfg.选股, ...(over.sources ? { 候选来源: over.sources } : {}) },
  };
  const engine = createStrategyEngine({ registry: stubRegistry(stubs()) });
  return engine({
    view, config, phase: "盘后", positions: [],
    ...(over.sectorOf ? { sectorOf: over.sectorOf } : {}),
    ...(over.sectorMapAt ? { sectorMapAt: over.sectorMapAt } : {}),
  } as any);
}

const codes = (card: any) => card.candidates.map((c: any) => c.code).sort();

describe("候选池：三路来源", () => {
  it("只开涨停池时，行为与从前一致", () => {
    const card = build({ sources: { 涨停池: true, 主线领涨: false, 量价: false } });
    expect(codes(card)).toEqual(["600183"]);
  });

  it("主线领涨：主线板块的领涨股进池，非主线板块的不进", () => {
    const card = build({ sources: { 涨停池: false, 主线领涨: true, 量价: false } });
    // 半导体是主线（必查链"半导体全链"含"半导体"），白酒不是
    expect(codes(card)).toEqual(["600900"]);
    expect(codes(card)).not.toContain("600519");
  });

  it("量价：主线成分里放量突破+多头排列的进池，缩量阴跌的不进", () => {
    const map: Record<string, string> = { "600900": "半导体", "600999": "半导体" };
    const card = build({
      sources: { 涨停池: false, 主线领涨: false, 量价: true },
      sectorOf: c => map[c] ?? null,
    });
    expect(codes(card)).toContain("600900");
    expect(codes(card)).not.toContain("600999");
  });

  it("量价那一路同样受主线约束 —— 不在主线上的票不进池", () => {
    // 把强势票划到非主线行业，它就不该出现
    const card = build({
      sources: { 涨停池: false, 主线领涨: false, 量价: true },
      sectorOf: c => (c === "600900" ? "白酒" : null),
    });
    expect(codes(card)).toEqual([]);
  });

  it("没有 代码→行业 映射时，量价那一路自动关闭并说明原因", () => {
    const card = build({ sources: { 涨停池: false, 主线领涨: false, 量价: true } });
    expect(codes(card)).toEqual([]);
    expect(card.warnings.some((w: string) => w.includes("代码→行业"))).toBe(true);
  });

  it("多路命中同一只票只进一次", () => {
    const map: Record<string, string> = { "600900": "半导体" };
    const card = build({
      sources: { 涨停池: true, 主线领涨: true, 量价: true },
      sectorOf: c => map[c] ?? null,
    });
    expect(new Set(codes(card)).size).toBe(codes(card).length);
  });

  it("涨停股仍排在非涨停来源之前 —— 名次会影响风控分配", () => {
    const map: Record<string, string> = { "600900": "半导体" };
    const card = build({
      sources: { 涨停池: true, 主线领涨: true, 量价: true },
      sectorOf: c => map[c] ?? null,
    });
    expect(card.candidates[0].code).toBe("600183");
  });

  it("非涨停来源在 thesis 里标明出处 —— 卡片上三路长得一样，不写就分不出", () => {
    const card = build({ sources: { 涨停池: false, 主线领涨: true, 量价: false } });
    expect(card.candidates[0].thesis).toContain("来源主线领涨");
  });

  it("映射采集时刻晚于评估日 → 明确告警前视，不闷着用", () => {
    const map: Record<string, string> = { "600900": "半导体" };
    const card = build({
      sources: { 涨停池: false, 主线领涨: false, 量价: true },
      sectorOf: c => map[c] ?? null,
      sectorMapAt: "2026-09-01 22:00:00.000",
    });
    expect(card.warnings.some((w: string) => w.includes("前视"))).toBe(true);
  });
});

/**
 * 链名 ≠ 板块名。
 *
 * 必查链的名字是"半导体全链"，而板块榜和涨停池里写的是"半导体材料 / 半导体设备 /
 * 集成电路制造"。子串互含一个都匹配不上，于是"按主线选票"对必查链型主线整个失效 ——
 * 而失效的表现只是候选少了几只，不报错、不告警，最难发现。
 *
 * 修法是让主线因子把它实际对应的真实板块名一起交出来（inputs.明细[].sectors），
 * 引擎把这些名字并进主线名单再做匹配。
 */
describe("主线匹配：链名要能落到真实板块名上", () => {
  function withChain(sectors: string[]) {
    const view = makeView({
      asOf: D,
      tradingDays: DAYS,
      securities: [sec("600641", "主板")],
      bars: { "600641": series("600641", DAYS, DAYS.map((_, i) => 10 + i * 0.05)) },
      quotes: { "600641": quote("600641", 11) },
      zt: {},
      sectors: {
        [D]: [{ date: D, ts: `${D} 15:00:00.000`, sector: "半导体材料", pct: 4.75, leaderCode: "600641" }],
      },
    });
    const cfg = baseConfig();
    const engine = createStrategyEngine({
      registry: stubRegistry(stubs({
        主线识别: {
          // value 里只有链名，真实板块名在 inputs.明细[].sectors 里
          value: ["半导体全链"], label: "半导体全链(必查链)", confidence: 0.85,
          inputs: { 明细: [{ name: "半导体全链", leaderCode: "600641", maxLbc: 3, sectors }] },
        },
      })),
    });
    return engine({
      view,
      config: { ...cfg, 选股: { ...cfg.选股, 候选来源: { 涨停池: false, 主线领涨: true, 量价: false } } },
      phase: "盘后", positions: [],
    } as any);
  }

  it("因子交出了真实板块名 → 该板块的领涨股进得来", () => {
    expect(codes(withChain(["半导体材料"]))).toEqual(["600641"]);
  });

  it("只有链名、没有真实板块名 → 匹配不上，如实空池（这就是修之前的行为）", () => {
    expect(codes(withChain([]))).toEqual([]);
  });
});
