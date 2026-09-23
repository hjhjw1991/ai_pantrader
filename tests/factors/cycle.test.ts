import { describe, it, expect } from "vitest";
import { CYCLE_FACTORS } from "@/lib/factors/cycle";
import type { FactorSpec, PointInTimeView, SentimentRow } from "@/lib/contracts";
import { makeView, weekdays } from "./view-double";

function run<T>(name: string, view: PointInTimeView, params: Record<string, unknown> = {}) {
  const spec = CYCLE_FACTORS.find(f => f.name === name) as FactorSpec<T> | undefined;
  if (!spec) throw new Error(`没有注册因子 ${name}`);
  return spec.fn({ view, params: { ...spec.defaults, ...params } });
}

const blank = (date: string): SentimentRow => ({
  date, up: 2000, down: 2000, flat: 100, unknown: 50, medianPct: 0, avgPct: 0,
  zt: 60, dt: 5, zb: 20, zbRate: 0.25, maxLbc: 4, lbCount: 10,
  firstPrev: 50, firstPromo: 0.2, multiPrev: 10, multiPromo: 0.4,
  ztPrem: 1, ztOpenPrem: 0.5, firstPrem: 0.8, multiPrem: 2, zbPrem: -1,
  highLbcPrev: 4, highPrem: 3,
});

const DAYS = weekdays("2025-09-01", 260);
const TODAY = DAYS[DAYS.length - 1];

/** 过去 259 天首板晋级率从 0.10 线性升到 0.30，今天的值由参数给 */
function hist(today: Partial<SentimentRow>, n = 260): SentimentRow[] {
  const ds = DAYS.slice(DAYS.length - n);
  return ds.map((d, i) => i === ds.length - 1
    ? { ...blank(d), ...today }
    : { ...blank(d), firstPromo: 0.1 + 0.2 * i / (ds.length - 1), medianPct: -2 + 4 * i / (ds.length - 1) });
}
const view = (rows: SentimentRow[], asOf = TODAY) => makeView({ asOf, sentiment: rows });

describe("情绪周期因子：读派生表，值是原始读数，标签看 250 日分位", () => {
  it("首板晋级率：值为当日比例，分位 ≥ 0.8 → 偏热", () => {
    const r = run<number>("首板晋级率", view(hist({ firstPromo: 0.35 })));
    expect(r.value).toBeCloseTo(0.35, 9);
    // 分位包含今天自己：最大是 (249 + 0.5) / 250
    expect(r.inputs?.分位).toBeGreaterThan(0.99);
    expect(r.label).toBe("偏热");
    expect(r.provenance).toBe("proxy");
  });

  it("分位 ≤ 0.2 → 偏冷；之间 → 常态", () => {
    expect(run<number>("首板晋级率", view(hist({ firstPromo: 0.11 }))).label).toBe("偏冷");
    expect(run<number>("首板晋级率", view(hist({ firstPromo: 0.2 }))).label).toBe("常态");
  });

  it("分位只看评估日之前的窗口 + 今天，窗口长度可调", () => {
    const r = run<any>("首板晋级率", view(hist({ firstPromo: 0.2 })), { 分位窗口: 20, 最少样本: 10 });
    expect(r.inputs?.样本).toBe(20);
    expect(r.label).toBe("偏冷");     // 最近 20 天都在 0.28 以上
  });

  it("评估日那天没有行 → 未构建，置信 0（不拿昨天的数冒充今天）", () => {
    const rows = hist({}).slice(0, -1);
    const r = run<number>("首板晋级率", view(rows));
    expect(r.label).toBe("未构建");
    expect(r.confidence).toBe(0);
  });

  it("历史不足 60 天 → 标签不看分位（样本太少分位没意义），置信减半", () => {
    const r = run<any>("首板晋级率", view(hist({ firstPromo: 0.35 }, 30)));
    expect(r.label).toBe("样本不足");
    expect(r.inputs?.分位).toBeNull();
    expect(r.confidence).toBeLessThan(0.8);
  });

  it("值为 null（昨天没有首板）→ 标签「无样本」，置信 0", () => {
    const r = run<number>("首板晋级率", view(hist({ firstPromo: null, firstPrev: 0 })));
    expect(r.value).toBeNull();
    expect(r.label).toBe("无样本");
    expect(r.confidence).toBe(0);
  });

  it("分母太小（昨日首板 < 5 家）→ 置信打折，一两只票的晋级率是噪声", () => {
    const full = run<number>("首板晋级率", view(hist({ firstPromo: 0.35 })));
    const few = run<number>("首板晋级率", view(hist({ firstPromo: 0.35, firstPrev: 3 })));
    expect(few.confidence).toBeLessThan(full.confidence);
  });

  it("评估日可以早于 asOf（回放）：取那天的行、那天之前的窗口", () => {
    const rows = hist({ firstPromo: 0.35 });
    const r = run<any>("首板晋级率", view(rows), { 日期: DAYS[200] });
    expect(r.inputs?.日期).toBe(DAYS[200]);
    expect(r.value).toBeCloseTo(rows[200].firstPromo!, 9);
  });

  it("涨跌中位数：负值也能正确排分位", () => {
    const r = run<number>("涨跌中位数", view(hist({ medianPct: -2.5 })));
    expect(r.label).toBe("偏冷");
  });

  it("七个因子都注册了，且都读同一张派生表", () => {
    expect(CYCLE_FACTORS.map(f => f.name).sort()).toEqual(
      ["首板晋级率", "连板晋级率", "涨停溢价", "高度板溢价", "炸板溢价", "日线炸板率", "涨跌中位数"].sort()
    );
    for (const f of CYCLE_FACTORS) {
      const r = f.fn({ view: view(hist({})), params: { ...f.defaults } });
      expect(r.confidence, f.name).toBeGreaterThan(0);
    }
  });

  it("涨停溢价的 inputs 带三桶与开盘溢价 —— 卡片上要看得出是哪一桶在亏", () => {
    const r = run<any>("涨停溢价", view(hist({ ztPrem: 1.5, firstPrem: 3, multiPrem: -2, zbPrem: -4, ztOpenPrem: 0.8 })));
    expect(r.inputs).toMatchObject({ 首板溢价: 3, 连板溢价: -2, 炸板溢价: -4, 开盘溢价: 0.8 });
  });
});
