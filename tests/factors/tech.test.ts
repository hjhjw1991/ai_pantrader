import { describe, it, expect } from "vitest";
import { TECH_FACTORS, bollinger, ma } from "@/lib/factors/tech";
import type { FactorSpec, PointInTimeView, MinuteBar } from "@/lib/contracts";
import { makeView, bar, seriesFrom, sec, weekdays } from "./view-double";

function run<T>(name: string, view: PointInTimeView, params: Record<string, unknown> = {}) {
  const spec = TECH_FACTORS.find(f => f.name === name) as FactorSpec<T> | undefined;
  if (!spec) throw new Error(`没有注册因子 ${name}`);
  return spec.fn({ view, params: { ...spec.defaults, ...params } });
}

const ds = weekdays("2026-06-01", 30);
const asOf = ds[29];

function viewOf(closes: number[], opts: { vol?: number[]; lastBar?: Partial<import("@/lib/contracts").DailyBar> } = {}) {
  const dates = ds.slice(ds.length - closes.length);
  const bars = seriesFrom("600000", dates, closes, { vol: opts.vol });
  if (opts.lastBar) bars[bars.length - 1] = { ...bars[bars.length - 1], ...opts.lastBar };
  return makeView({ asOf: dates[dates.length - 1], securities: [sec("600000", "主板")], bars: { "600000": bars } });
}

describe("bollinger", () => {
  it("1..20 的已知数值（总体标准差，非样本标准差）", () => {
    const b = bollinger(Array.from({ length: 20 }, (_, i) => i + 1), 20, 2)!;
    expect(b.mid).toBeCloseTo(10.5, 6);
    expect(b.upper).toBeCloseTo(22.032563, 5);
    expect(b.lower).toBeCloseTo(-1.032563, 5);
    expect(b.pos).toBeCloseTo(91.187724, 3);
    expect(b.width).toBeCloseTo(219.6679, 3);
  });

  it("样本不足返回 null，不用短样本硬算", () => {
    expect(bollinger([1, 2, 3], 20, 2)).toBeNull();
  });

  it("横盘零波动时上下轨重合，pos 取 50 而不是 NaN", () => {
    const b = bollinger(Array(20).fill(20), 20, 2)!;
    expect(b.width).toBe(0);
    expect(b.pos).toBe(50);
    expect(Number.isNaN(b.pos)).toBe(false);
  });
});

describe("布林因子", () => {
  it("布林位置 / 布林带宽", () => {
    const closes = Array.from({ length: 20 }, (_, i) => i + 1);
    const view = viewOf(closes);
    expect(run<number | null>("布林位置", view, { code: "600000" }).value).toBeCloseTo(91.187724, 3);
    expect(run<number | null>("布林带宽", view, { code: "600000" }).value).toBeCloseTo(219.6679, 3);
  });

  it("突破上轨时 pos > 100 —— 不 clamp，clamp 会把'强势突破'和'贴上轨'混为一谈", () => {
    const closes = [...Array(19).fill(10), 13];
    const b = bollinger(closes, 20, 2)!;
    expect(b.pos).toBeGreaterThan(100);
  });

  it("样本不足 → null + 置信 0", () => {
    const r = run<number | null>("布林位置", viewOf([10, 11, 12]), { code: "600000" });
    expect(r.value).toBeNull();
    expect(r.confidence).toBe(0);
  });
});

describe("均线方向", () => {
  it("单边上行 → 多头排列 = 2", () => {
    const closes = Array.from({ length: 26 }, (_, i) => 10 + i * 0.3);
    const r = run<number>("均线方向", viewOf(closes), { code: "600000" });
    expect(r.value).toBe(2);
    expect(r.label).toBe("多头排列");
  });

  it("单边下行 → 空头排列 = -2", () => {
    const closes = Array.from({ length: 26 }, (_, i) => 20 - i * 0.3);
    const r = run<number>("均线方向", viewOf(closes), { code: "600000" });
    expect(r.value).toBe(-2);
    expect(r.label).toBe("空头排列");
  });

  it("ma 计算", () => {
    expect(ma([1, 2, 3, 4, 5], 5)).toBeCloseTo(3, 6);
    expect(ma([1, 2, 3], 5)).toBeNull();
  });
});

describe("量能", () => {
  it("三倍量 → 巨量", () => {
    const closes = Array(22).fill(10);
    const vol = [...Array(21).fill(1e6), 3e6];
    const r = run<number | null>("量能", viewOf(closes, { vol }), { code: "600000" });
    expect(r.value).toBeCloseTo(3, 6);
    expect(r.label).toBe("巨量");
  });

  it("半量 → 缩量", () => {
    const closes = Array(22).fill(10);
    const vol = [...Array(21).fill(1e6), 5e5];
    const r = run<number | null>("量能", viewOf(closes, { vol }), { code: "600000" });
    expect(r.value).toBeCloseTo(0.5, 6);
    expect(r.label).toBe("缩量");
  });
});

describe("洗盘vs派发 —— 2026-07-21 深科技那次的教训要编码进去", () => {
  it("缩量冲高回落 + 收在日内中上部 + 站稳均线 → 判洗盘（正分）", () => {
    const closes = Array.from({ length: 21 }, (_, i) => 10 + i * 0.025).concat([10.6]);
    const vol = [...Array(21).fill(1e6), 8e5];
    const view = viewOf(closes, { vol, lastBar: { o: 10, h: 11, l: 9.9, c: 10.6, vol: 8e5 } });
    const r = run<number>("洗盘vs派发", view, { code: "600000" });
    expect(r.value).toBeGreaterThan(25);
    expect(r.label).toBe("洗盘");
  });

  it("巨量冲高 + 收在日内最低 + 跌破均线 + 高位 → 判派发（负分）", () => {
    const closes = Array.from({ length: 21 }, (_, i) => 6 + i * 0.45).concat([9.55]);
    const vol = [...Array(21).fill(1e6), 3e6];
    const view = viewOf(closes, { vol, lastBar: { o: 10, h: 11, l: 9.5, c: 9.55, vol: 3e6 } });
    const r = run<number>("洗盘vs派发", view, { code: "600000" });
    expect(r.value).toBeLessThan(-25);
    expect(r.label).toBe("派发");
    expect(r.value).toBeGreaterThanOrEqual(-100);
  });

  it("同样是冲高回落，量能与收盘位置决定结论 —— 光看'回落'会把洗盘错判成见光死", () => {
    const closes = Array.from({ length: 21 }, (_, i) => 10 + i * 0.025).concat([10.6]);
    const shake = run<number>("洗盘vs派发",
      viewOf(closes, { vol: [...Array(21).fill(1e6), 8e5], lastBar: { o: 10, h: 11, l: 9.9, c: 10.6, vol: 8e5 } }),
      { code: "600000" });
    const dump = run<number>("洗盘vs派发",
      viewOf(closes, { vol: [...Array(21).fill(1e6), 3e6], lastBar: { o: 10, h: 11, l: 9.9, c: 9.95, vol: 3e6 } }),
      { code: "600000" });
    expect(shake.value).toBeGreaterThan(dump.value);
  });
});

describe("分时博弈 —— 分钟线不可回补，没有就说没有", () => {
  const mb = (ts: string, c: number, vol = 1000): MinuteBar =>
    ({ code: "600000", ts, period: 5, o: c, h: c, l: c, c, vol });

  it("无分钟线 → null + 置信 0，不用日线假造", () => {
    const r = run<number | null>("分时博弈", viewOf(Array(22).fill(10)), { code: "600000" });
    expect(r.value).toBeNull();
    expect(r.confidence).toBe(0);
  });

  it("尾盘拉升 → 收盘强于分时均价", () => {
    const minutes = {
      "600000:5": [
        mb("2026-06-30 09:35:00", 10), mb("2026-06-30 10:00:00", 10),
        mb("2026-06-30 13:00:00", 10), mb("2026-06-30 14:55:00", 10.5),
      ],
    };
    const base = viewOf(Array(22).fill(10));
    const view = makeView({
      asOf: base.asOf, securities: [sec("600000", "主板")],
      bars: { "600000": base.dailyBars("600000", 30) }, minutes,
    });
    const r = run<number | null>("分时博弈", view, { code: "600000" });
    expect(r.value as number).toBeGreaterThan(0);
    expect(r.provenance).toBe("real");
  });
});

describe("因子确定性", () => {
  it("同一个 view 跑两次结果完全一致", () => {
    const view = viewOf(Array.from({ length: 22 }, (_, i) => 10 + i * 0.1));
    for (const spec of TECH_FACTORS) {
      const a = spec.fn({ view, params: { ...spec.defaults, code: "600000" } });
      const b = spec.fn({ view, params: { ...spec.defaults, code: "600000" } });
      expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    }
  });
});

describe("缺 code 参数时报错而不是静默返回 0", () => {
  it("抛错", () => {
    const view = viewOf(Array(22).fill(10));
    expect(() => run("布林位置", view)).toThrow(/code/);
  });
});

/** 让 bar() 在本文件被用到（seriesFrom 内部构造之外的直接用法） */
it("bar 默认收盘不等最高", () => {
  const b = bar("600000", "2026-08-03", 10);
  expect(b.h).toBeGreaterThan(b.c);
});
