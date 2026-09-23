import { describe, it, expect } from "vitest";
import { RISK_FACTORS, rsi, bias, kdj, tdxSma } from "@/lib/factors/risk";
import type { FactorSpec, PointInTimeView } from "@/lib/contracts";
import { makeView, seriesFrom, sec, weekdays } from "./view-double";

function run<T>(name: string, view: PointInTimeView, params: Record<string, unknown> = {}) {
  const spec = RISK_FACTORS.find(f => f.name === name) as FactorSpec<T> | undefined;
  if (!spec) throw new Error(`没有注册因子 ${name}`);
  return spec.fn({ view, params: { ...spec.defaults, code: "600000", ...params } });
}

const ds = weekdays("2026-06-01", 40);

function viewOf(closes: number[], board: "主板" | "创业板" = "主板", adj?: number[]) {
  const dates = ds.slice(ds.length - closes.length);
  const bars = seriesFrom("600000", dates, closes);
  if (adj !== undefined) bars.forEach((b, i) => { b.adjFactor = adj[i]; });
  return makeView({
    asOf: dates[dates.length - 1],
    securities: [sec("600000", board)],
    bars: { "600000": bars },
  });
}

/* ------------------------------- 纯函数 ------------------------------- */

describe("tdxSma（通达信 SMA(X,N,M)）", () => {
  it("Y = (M·X + (N−M)·Y') / N，首值取 X[0] —— 与通达信显示的数字对齐", () => {
    const y = tdxSma([10, 20, 30], 3, 1);
    expect(y[0]).toBeCloseTo(10, 9);
    expect(y[1]).toBeCloseTo((20 + 2 * 10) / 3, 9);
    expect(y[2]).toBeCloseTo((30 + 2 * y[1]) / 3, 9);
  });
});

describe("rsi", () => {
  it("一路上涨 → 100", () => {
    expect(rsi(Array.from({ length: 20 }, (_, i) => 10 + i), 6)).toBeCloseTo(100, 6);
  });
  it("一路下跌 → 0", () => {
    expect(rsi(Array.from({ length: 20 }, (_, i) => 30 - i), 6)).toBeCloseTo(0, 6);
  });
  it("完全横盘 → 50，不是 NaN —— 0/0 要有定义", () => {
    const r = rsi(Array(20).fill(10), 6);
    expect(r).toBe(50);
  });
  it("样本不足返回 null", () => {
    expect(rsi([1, 2, 3], 6)).toBeNull();
  });
});

describe("bias", () => {
  it("(C − MA_n) / MA_n，单位百分点", () => {
    // MA5 = (10+10+10+10+15)/5 = 11；(15−11)/11 = 36.3636%
    expect(bias([10, 10, 10, 10, 15], 5)).toBeCloseTo(36.363636, 4);
  });
  it("样本不足返回 null", () => {
    expect(bias([10, 11], 5)).toBeNull();
  });
});

describe("kdj", () => {
  it("收在 N 日最高 → RSV=100，K/D 向上，J = 3K − 2D", () => {
    const n = 12;
    const cs = Array.from({ length: n }, (_, i) => 10 + i);
    const r = kdj(cs, cs, cs, 9, 3, 3)!;
    expect(r.j).toBeCloseTo(3 * r.k - 2 * r.d, 9);
    expect(r.k).toBeGreaterThan(50);
  });
  it("样本不足返回 null", () => {
    expect(kdj([1, 2], [1, 2], [1, 2], 9, 3, 3)).toBeNull();
  });
});

/* -------------------------------- 因子 -------------------------------- */

describe("超买超卖", () => {
  it("连续大涨 → 超买（值为正）", () => {
    const cs = Array.from({ length: 30 }, (_, i) => 10 * Math.pow(1.04, i));
    const r = run<number>("超买超卖", viewOf(cs));
    expect(r.value).toBeGreaterThan(0);
    expect(String(r.label)).toMatch(/超买/);
  });

  it("连续大跌 → 超卖（值为负）", () => {
    const cs = Array.from({ length: 30 }, (_, i) => 30 * Math.pow(0.96, i));
    const r = run<number>("超买超卖", viewOf(cs));
    expect(r.value).toBeLessThan(0);
    expect(String(r.label)).toMatch(/超卖/);
  });

  it("窄幅震荡 → 中性", () => {
    const cs = Array.from({ length: 30 }, (_, i) => 10 + (i % 2 === 0 ? 0.05 : -0.05));
    const r = run<number>("超买超卖", viewOf(cs));
    expect(r.value).toBe(0);
    expect(r.label).toBe("中性");
  });

  it("**除权不能被当成超卖** —— 原始价腰斩、因子翻倍的那天，复权后是平的", () => {
    // 前 29 根 10 元、因子 1；最后一根原始价 5 元（10 送 10），因子 2
    const cs = [...Array(29).fill(10), 5];
    const adj = [...Array(29).fill(1), 2];
    const r = run<number>("超买超卖", viewOf(cs, "主板", adj));
    expect(r.value).toBe(0);
    expect(String(r.label)).not.toMatch(/超卖/);
  });

  it("20cm 板的乖离容忍更宽 —— 同样的涨幅在主板是超买、在创业板未必", () => {
    // 前 25 根平，最后 5 根抬到 +20% 附近：BIAS5 落在 15%~25% 之间
    const cs = [...Array(25).fill(10), 10, 10.5, 11, 12, 13.5];
    const main = run<any>("超买超卖", viewOf(cs, "主板"));
    const gem = run<any>("超买超卖", viewOf(cs, "创业板"));
    expect(main.inputs?.乖离超限).toBe(true);
    expect(gem.inputs?.乖离超限).toBe(false);
  });

  it("样本不足 → confidence 0，且不给方向 —— 短样本的 RSI 不可信", () => {
    const r = run<number>("超买超卖", viewOf([10, 11, 12]));
    expect(r.confidence).toBe(0);
    expect(r.value).toBe(0);
  });

  it("明细里带上三个分项，给人看得出是哪一项在报警", () => {
    const cs = Array.from({ length: 30 }, (_, i) => 10 * Math.pow(1.04, i));
    const r = run<any>("超买超卖", viewOf(cs));
    expect(r.inputs).toHaveProperty("RSI");
    expect(r.inputs).toHaveProperty("乖离率");
    expect(r.inputs).toHaveProperty("KDJ_J");
  });
});

describe("ST状态", () => {
  const stView = (asOf: string, hist: Array<{ from: string; to: string | null }>) =>
    makeView({
      asOf,
      securities: [sec("600000", "主板", { name: "*ST测试", isStHistory: hist })],
      bars: { "600000": seriesFrom("600000", [asOf], [5]) },
    });

  it("戴帽期间 → ST，confidence 1", () => {
    const r = run<number>("ST状态", stView("2026-09-01", [{ from: "2026-08-04", to: null }]));
    expect(r.value).toBe(1);
    expect(r.label).toBe("ST");
    expect(r.confidence).toBe(1);
  });

  it("摘帽之后 → 非ST", () => {
    const r = run<number>("ST状态", stView("2026-09-10", [{ from: "2026-08-04", to: "2026-09-05" }]));
    expect(r.value).toBe(0);
    expect(r.label).toBe("非ST");
  });

  it("**观测起点之前没有 ST 区间 → 未观测，不是「非ST」** —— 否则回测会放心买进当时正戴帽的票", () => {
    const r = run<number>("ST状态", stView("2024-03-01", []));
    expect(r.label).toBe("未观测");
    expect(r.confidence).toBe(0);
  });

  it("观测起点之前若区间确实覆盖到了，照样判 ST —— 看见了就是看见了", () => {
    const r = run<number>("ST状态", stView("2024-03-01", [{ from: "2023-01-01", to: null }]));
    expect(r.value).toBe(1);
    expect(r.confidence).toBe(1);
  });

  it("证券未知 → confidence 0", () => {
    const v = makeView({ asOf: "2026-09-01", securities: [] });
    const r = run<number>("ST状态", v, { code: "999999" });
    expect(r.confidence).toBe(0);
  });
});

describe("解禁压力", () => {
  const v = (lifts: Array<{ date: string; freeRatio: number | null }>) => makeView({
    asOf: "2026-09-23", securities: [sec("600000", "主板")],
    bars: { "600000": seriesFrom("600000", ["2026-09-23"], [10]) },
    lifts: { "600000": lifts.map(l => ({ ...l, liftMktcap: 1e8, shareType: "首发原股东限售股份" })) },
  });

  it("未来窗口内无解禁 → 0，「无解禁」", () => {
    const r = run<number>("解禁压力", v([]));
    expect(r.value).toBe(0);
    expect(r.label).toBe("无解禁");
    expect(r.confidence).toBe(1);
  });

  it("多批解禁比例相加", () => {
    const r = run<number>("解禁压力", v([
      { date: "2026-10-15", freeRatio: 0.03 }, { date: "2026-11-20", freeRatio: 0.04 },
    ]));
    expect(r.value).toBeCloseTo(0.07, 9);
  });

  it("≥ 预警比例（默认 5%）→ 预警；≥ 严重比例（默认 15%）→ 严重", () => {
    expect(run<number>("解禁压力", v([{ date: "2026-10-15", freeRatio: 0.06 }])).label).toBe("预警");
    expect(run<number>("解禁压力", v([{ date: "2026-10-15", freeRatio: 0.2 }])).label).toBe("严重");
    expect(run<number>("解禁压力", v([{ date: "2026-10-15", freeRatio: 0.01 }])).label).toBe("小额");
  });

  it("比例缺失时降低置信度 —— 不知道多少不等于没有", () => {
    const r = run<number>("解禁压力", v([{ date: "2026-10-15", freeRatio: null }]));
    expect(r.confidence).toBeLessThan(1);
  });

  it("明细带上最近一次解禁日，给人看得出还有几天", () => {
    const r = run<any>("解禁压力", v([{ date: "2026-10-15", freeRatio: 0.06 }]));
    expect(r.inputs?.最近解禁日).toBe("2026-10-15");
  });
});

describe("减持计划", () => {
  const v = (asOf: string, plans: Array<{ maxRatio: number | null; startDate?: string }>) => makeView({
    asOf, securities: [sec("002237", "主板")],
    bars: { "002237": seriesFrom("002237", [asOf], [10]) },
    plans: { "002237": plans.map(p => ({
      actor: "股东甲", startDate: p.startDate ?? "2026-10-23", endDate: "2027-01-22",
      maxRatio: p.maxRatio, maxShares: 1e7, firstSeen: "2026-09-23",
    })) },
  });

  it("无计划 → 0", () => {
    const r = run<number>("减持计划", v("2026-09-23", []), { code: "002237" });
    expect(r.value).toBe(0);
    expect(r.label).toBe("无计划");
  });

  it("多个股东的计划比例相加（占总股本）", () => {
    const r = run<number>("减持计划", v("2026-09-23", [{ maxRatio: 0.01 }, { maxRatio: 0.02 }]), { code: "002237" });
    expect(r.value).toBeCloseTo(0.03, 9);
  });

  it("≥ 1% 预警、≥ 3% 严重（默认）", () => {
    expect(run<number>("减持计划", v("2026-09-23", [{ maxRatio: 0.005 }]), { code: "002237" }).label).toBe("有计划");
    expect(run<number>("减持计划", v("2026-09-23", [{ maxRatio: 0.01 }]), { code: "002237" }).label).toBe("预警");
    expect(run<number>("减持计划", v("2026-09-23", [{ maxRatio: 0.03 }]), { code: "002237" }).label).toBe("严重");
  });

  it("**观测起点之前 → 未观测，confidence 0** —— 源只留最近两条，更早的查不到不等于没有", () => {
    const r = run<number>("减持计划", v("2026-06-01", []), { code: "002237" });
    expect(r.label).toBe("未观测");
    expect(r.confidence).toBe(0);
  });
});
