/**
 * 技术结构：EMA / MACD / ATR / 分形拐点 / 结构位 / M 顶 W 底。
 *
 * 口径对齐通达信：EMA 首值取 X[0]，MACD 柱 = 2 × (DIF − DEA)，ATR = MA(TR, N)。
 * 与用户手机上看到的数字对不上，这套东西就没人信了（见 risk.ts 里 tdxSma 的说明）。
 */
import { describe, it, expect } from "vitest";
import {
  ema, macd, crosses, atr, pivots, structureLevels, doublePattern, STRUCTURE_FACTORS,
} from "@/lib/factors/structure";
import type { DailyBar, FactorSpec, PointInTimeView } from "@/lib/contracts";
import { makeView, bar, sec, weekdays } from "./view-double";

function run<T>(name: string, view: PointInTimeView, params: Record<string, unknown> = {}) {
  const spec = STRUCTURE_FACTORS.find(f => f.name === name) as FactorSpec<T> | undefined;
  if (!spec) throw new Error(`没有注册因子 ${name}`);
  return spec.fn({ view, params: { ...spec.defaults, code: "600000", ...params } });
}

/** 按收盘序列造日线：高低各留 1%，开盘 = 前收 */
function barsOf(closes: number[], start = "2025-06-02", adj = 1): DailyBar[] {
  const ds = weekdays(start, closes.length);
  return closes.map((c, i) => bar("600000", ds[i], c, {
    o: i === 0 ? c : closes[i - 1], h: Math.max(c, i === 0 ? c : closes[i - 1]) * 1.01,
    l: Math.min(c, i === 0 ? c : closes[i - 1]) * 0.99, adjFactor: adj,
  }));
}
function viewOf(bs: DailyBar[], weekly?: DailyBar[]) {
  return makeView({
    asOf: bs[bs.length - 1].date, securities: [sec("600000", "主板")],
    bars: { "600000": bs },
    ...(weekly ? { periods: { "600000|W": weekly } } : {}),
  });
}

/* -------------------------------- 纯函数 -------------------------------- */

describe("ema（通达信口径）", () => {
  it("首值取 X[0]，α = 2/(N+1)", () => {
    const e = ema([10, 20, 30], 3);
    expect(e[0]).toBe(10);
    expect(e[1]).toBeCloseTo(15, 9);
    expect(e[2]).toBeCloseTo(22.5, 9);
  });
});

describe("macd", () => {
  it("常数序列 DIF = DEA = 柱 = 0", () => {
    const m = macd(Array(60).fill(10));
    expect(m.dif.at(-1)).toBeCloseTo(0, 9);
    expect(m.hist.at(-1)).toBeCloseTo(0, 9);
  });
  it("柱 = 2 × (DIF − DEA)", () => {
    const xs = Array.from({ length: 80 }, (_, i) => 10 + Math.sin(i / 5) * 2);
    const m = macd(xs);
    const i = 70;
    expect(m.hist[i]).toBeCloseTo(2 * (m.dif[i] - m.dea[i]), 9);
  });
  it("单调上涨 DIF > 0；单调下跌 DIF < 0", () => {
    expect(macd(Array.from({ length: 60 }, (_, i) => 10 + i)).dif.at(-1)!).toBeGreaterThan(0);
    expect(macd(Array.from({ length: 60 }, (_, i) => 70 - i)).dif.at(-1)!).toBeLessThan(0);
  });
});

describe("crosses", () => {
  it("DIF 由下穿上 → 金叉；由上穿下 → 死叉；贴着不算", () => {
    const ev = crosses([-1, -0.5, 0.2, 0.3, -0.1, -0.1], [0, 0, 0, 0, 0, 0]);
    expect(ev).toEqual([{ i: 2, kind: "金叉" }, { i: 4, kind: "死叉" }]);
  });
  it("从 0 起步离开也算：前一根 ≤ 0、当前 > 0", () => {
    expect(crosses([0, 1], [0, 0])).toEqual([{ i: 1, kind: "金叉" }]);
  });
});

describe("atr（MA(TR, N)）", () => {
  it("TR 取 高−低 / |高−昨收| / |低−昨收| 的最大值", () => {
    const b = (h: number, l: number, c: number) => ({ h, l, c }) as DailyBar;
    // 第二根：跳空高开，高 12 低 11，昨收 10 → TR = 2
    expect(atr([b(10.5, 9.5, 10), b(12, 11, 11.5)], 1)).toBeCloseTo(2, 9);
  });
  it("样本不足 → null", () => {
    expect(atr(barsOf([10, 11]), 14)).toBeNull();
  });
});

describe("pivots（分形拐点，左右各 k 根）", () => {
  const closes = [10, 11, 12, 13, 12, 11, 10, 11, 12, 11, 10, 9, 10];
  const bs = barsOf(closes);
  it("高点：比左边 k 根都高、不低于右边 k 根", () => {
    const p = pivots(bs, 2);
    expect(p.filter(x => x.kind === "高").map(x => x.i)).toEqual([3, 8]);
    expect(p.filter(x => x.kind === "低").map(x => x.i)).toEqual([6]);
  });
  it("最后 k 根不可能是拐点 —— 右边还没走出来，判了就是未来函数", () => {
    const p = pivots(bs, 2);
    expect(p.every(x => x.i <= bs.length - 1 - 2)).toBe(true);
  });
});

describe("structureLevels", () => {
  it("阻力 = 现价上方最近的拐点高，支撑 = 下方最近的拐点低", () => {
    const pv = [
      { i: 1, kind: "高" as const, price: 15 }, { i: 2, kind: "低" as const, price: 8 },
      { i: 3, kind: "高" as const, price: 12 }, { i: 4, kind: "低" as const, price: 9.5 },
    ];
    expect(structureLevels(pv, 10)).toEqual({ resistance: 12, support: 9.5 });
  });
  it("创新高时上方无结构位 → null（目标不知道，不编一个）", () => {
    expect(structureLevels([{ i: 1, kind: "高", price: 9 }], 10).resistance).toBeNull();
  });
});

describe("doublePattern（M 顶 / W 底）", () => {
  // 冲高 13 → 回落 11（颈线）→ 再冲 13.1 → 跌破 11
  const up = [10, 11, 12, 13, 12.5, 12, 11.5, 11, 11.5, 12, 12.5, 13.1, 12.6, 12.1, 11.6];
  it("两高相差 ≤3%、中间回落出颈线 → 形成中", () => {
    const p = doublePattern(barsOf(up), { k: 2 });
    expect(p?.kind).toBe("M顶");
    expect(p?.state).toBe("形成中");
    expect(p?.neckline).toBeCloseTo(11 * 0.99, 6);
  });
  it("收盘跌破颈线 → 确认，并记下跌破那天", () => {
    const bs = barsOf([...up, 10.8, 10.5]);
    const p = doublePattern(bs, { k: 2 });
    expect(p?.state).toBe("确认");
    expect(p?.breakDate).toBe(bs[15].date);
  });
  it("第二个高点明显更高（>3%）→ 不是 M 顶，是突破", () => {
    const bs = barsOf([10, 11, 12, 13, 12.5, 12, 11.5, 11, 11.5, 12, 13, 14, 13.5, 13, 12.5]);
    expect(doublePattern(bs, { k: 2 })).toBeNull();
  });
  it("W 底对称：两低相近、中间反弹出颈线，收盘上破 → 确认", () => {
    const dn = up.map(x => 24 - x);
    const bs = barsOf([...dn, 13.2, 13.6]);
    const p = doublePattern(bs, { k: 2 });
    expect(p?.kind).toBe("W底");
    expect(p?.state).toBe("确认");
  });
  it("破颈线太久以前（> 确认时效）→ 不再报：那是旧结构，不说明现在", () => {
    const bs = barsOf([...up, 10.8, ...Array(15).fill(10.5)]);
    expect(doublePattern(bs, { k: 2, confirmAge: 10 })).toBeNull();
    expect(doublePattern(bs, { k: 2, confirmAge: 30 })?.state).toBe("确认");
  });
  it("第二顶之后迟迟不破颈线、拖太久 → 不再算形成中", () => {
    const bs = barsOf([...up, ...Array(25).fill(11.8)]);
    expect(doublePattern(bs, { k: 2, formAge: 20 })).toBeNull();
  });
  it("形态点带日期和价格，给 K 线图标注用", () => {
    const p = doublePattern(barsOf(up), { k: 2 })!;
    expect(p.points.map(x => x.role)).toEqual(["第一顶", "颈线", "第二顶"]);
    expect(p.points[0].date < p.points[2].date).toBe(true);
  });
});

/* -------------------------------- 因子 -------------------------------- */

const wave = (n: number, base = 10) => Array.from({ length: n }, (_, i) => base + Math.sin(i / 6) * 2 + i * 0.01);

describe("日线MACD", () => {
  it("刚金叉 → 标签「金叉」并带交叉日期与距今根数", () => {
    // 先跌后涨：末尾刚形成金叉
    const xs = [...Array.from({ length: 60 }, (_, i) => 20 - i * 0.1), ...Array.from({ length: 2 }, (_, i) => 14.5 + i * 0.4)];
    const r = run<any>("日线MACD", viewOf(barsOf(xs)));
    expect(r.label).toBe("金叉");
    const x = r.inputs?.最近交叉 as { 类型: string; 距今: number };
    expect(x.类型).toBe("金叉");
    expect(x.距今).toBeLessThanOrEqual(3);
  });
  it("数值换算到前复权口径：同一条走势、复权因子 ×3，DIF 不变", () => {
    const xs = wave(120);
    const a = run<any>("日线MACD", viewOf(barsOf(xs, "2025-06-02", 1)));
    const b = run<any>("日线MACD", viewOf(barsOf(xs, "2025-06-02", 3)));
    expect(b.inputs?.DIF as number).toBeCloseTo(a.inputs?.DIF as number, 9);
  });
  it("样本不足 60 根 → 置信 0", () => {
    expect(run<number>("日线MACD", viewOf(barsOf(wave(30)))).confidence).toBe(0);
  });
});

describe("周线MACD", () => {
  it("读 periodBars(W)；不足 35 周 → 置信 0", () => {
    const d = barsOf(wave(80));
    expect(run<number>("周线MACD", viewOf(d, barsOf(wave(20)))).confidence).toBe(0);
    const r = run<number>("周线MACD", viewOf(d, barsOf(wave(80))));
    expect(r.confidence).toBeGreaterThan(0);
  });
});

describe("周线MACD 数据错位", () => {
  it("周线有、日线为空 → 样本不足，不抛错", () => {
    const v = makeView({ asOf: "2026-09-22", securities: [sec("600000", "主板")], bars: {},
      periods: { "600000|W": barsOf(wave(80)) } });
    const r = run<number>("周线MACD", v);
    expect(r.confidence).toBe(0);
    expect(r.label).toBe("样本不足");
  });
});

describe("ATR", () => {
  it("值为 ATR / 收盘（波动率比例），inputs 给原始价口径的 ATR", () => {
    const r = run<any>("ATR", viewOf(barsOf(Array(30).fill(10), "2025-06-02", 2)));
    // 平走：每根高低各 1% → TR ≈ 0.2（原始价口径），比例 ≈ 0.02
    expect(r.value).toBeCloseTo(0.02, 3);
    expect(r.inputs?.ATR).toBeCloseTo(0.2, 3);
  });
});

describe("结构位", () => {
  it("阻力 / 支撑换算回**原始价**口径，值为结构盈亏比", () => {
    // 复权因子 2。拐点高有两个：13.13（远）与 12.12（近）—— 阻力取现价上方**最近**的那个。
    // 断言的是原始价（后复权除以当日因子），不是后复权价
    const xs = [10, 11, 12, 13, 12, 11, 10, 9, 10, 11, 12, 11, 10.5, 11, 11.2, 11];
    const r = run<any>("结构位", viewOf(barsOf(xs, "2025-06-02", 2)), { 拐点宽度: 2 });
    expect(r.inputs?.阻力).toBeCloseTo(12 * 1.01, 6);
    expect(r.inputs?.支撑).toBeGreaterThan(8);
    expect(r.inputs?.支撑).toBeLessThan(11);
    const px = 11;
    const res = r.inputs?.阻力 as number, sup = r.inputs?.支撑 as number;
    expect(r.value).toBeCloseTo((res - px) / (px - sup), 6);
  });
  it("离现价不到 0.5 个 ATR 的拐点是噪声，跳过去找下一个", () => {
    const pv = [
      { i: 1, kind: "高" as const, price: 10.1 }, { i: 2, kind: "高" as const, price: 12 },
      { i: 3, kind: "低" as const, price: 9.95 }, { i: 4, kind: "低" as const, price: 9 },
    ];
    expect(structureLevels(pv, 10, 0.5)).toEqual({ resistance: 12, support: 9 });
  });
  it("上方无阻力 → 值 null、标签「上方无结构位」", () => {
    const xs = Array.from({ length: 30 }, (_, i) => 10 + i * 0.3);
    const r = run<any>("结构位", viewOf(barsOf(xs)));
    expect(r.value).toBeNull();
    expect(r.label).toBe("上方无结构位");
  });
});

describe("M顶W底 因子", () => {
  it("M 顶确认 → −1；形态点换算成原始价", () => {
    const up = [10, 11, 12, 13, 12.5, 12, 11.5, 11, 11.5, 12, 12.5, 13.1, 12.6, 12.1, 11.6, 10.8, 10.5];
    const r = run<any>("M顶W底", viewOf(barsOf(up, "2025-06-02", 2)), { 拐点宽度: 2, 最小间隔: 5 });
    expect(r.value).toBe(-1);
    expect(r.label).toBe("M顶确认");
    expect((r.inputs?.形态点 as Array<{ 价格: number }>)[0].价格).toBeCloseTo(13 * 1.01, 6);
  });
  it("没有形态 → 0，「无」", () => {
    const r = run<any>("M顶W底", viewOf(barsOf(Array.from({ length: 40 }, (_, i) => 10 + i * 0.1))));
    expect(r.value).toBe(0);
    expect(r.label).toBe("无");
  });
});

describe("停牌多年的票不拿最后一根当今天", () => {
  it("最后一根 K 线落后评估日 > 5 个交易日 → 四个因子都置信 0、「无近期数据」", () => {
    const bs = barsOf(wave(120), "2025-01-06");
    const later = weekdays("2025-01-06", 140);
    const v = makeView({
      asOf: later[139], tradingDays: later,
      securities: [sec("600000", "主板")], bars: { "600000": bs },
    });
    for (const n of ["日线MACD", "ATR", "结构位", "M顶W底"]) {
      const r = run<any>(n, v);
      expect(r.label, n).toBe("无近期数据");
      expect(r.confidence, n).toBe(0);
      expect(r.inputs?.滞后交易日, n).toBe(20);
    }
  });
  it("停牌 2 天照常算，滞后写进 inputs", () => {
    const bs = barsOf(wave(120), "2025-01-06");
    const later = weekdays("2025-01-06", 122);
    const v = makeView({ asOf: later[121], tradingDays: later, securities: [sec("600000", "主板")], bars: { "600000": bs } });
    const r = run<any>("日线MACD", v);
    expect(r.confidence).toBe(1);
    expect(r.inputs?.滞后交易日).toBe(2);
  });
});
