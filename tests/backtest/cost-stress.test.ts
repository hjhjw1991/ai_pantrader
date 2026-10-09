import { describe, it, expect } from "vitest";
import {
  costStress, scaleConstraints, levelOf, toStressPoint, evaluateCostStress,
  VERY_FRAGILE_AT, FRAGILE_AT, ROBUST_NEEDS,
  type CostLevel, type StressOutcome,
} from "@/lib/backtest/cost-stress";
import { DEFAULT_CONSTRAINTS } from "@/lib/contracts";
import { MIN_SAMPLE_DAYS, MIN_SAMPLE_TRADES } from "@/lib/backtest/metrics";
import type { BacktestMetrics, EquityPoint } from "@/lib/contracts";

const base = DEFAULT_CONSTRAINTS;

/**
 * 假跑测：按倍数直接给定净收益曲线，不碰真实引擎。
 *
 * equity 造满 MIN_SAMPLE_DAYS 根是因为"退化"会额外插一条 note，
 * 那会盖住这里真正要验的判定；退化本身另外有专门的用例。
 */
function runner(net: (m: number) => number, opts: { trades?: number; days?: number } = {}) {
  const trades = opts.trades ?? 200;
  const days = opts.days ?? MIN_SAMPLE_DAYS + 8;
  return (level: CostLevel): StressOutcome => {
    const tr = net(level.multiplier);
    const eq: EquityPoint[] = Array.from({ length: days }, (_, i) => ({
      date: `d${i}`, equity: 100000 * (1 + (tr * i) / (days - 1)), position: 0,
    }));
    const m: BacktestMetrics = {
      calmar: 1.5, annualReturn: tr, maxDrawdown: 0.1, sharpe: 1,
      winRate: 0.5, profitFactor: 1.2, trades, avgHoldDays: 5,
      triggerRate: 0.5, buyDecisions: 100, buyFilled: 50,
    };
    return { metrics: m, equity: eq };
  };
}

describe("成本档位缩放", () => {
  it("×0 是零摩擦，得到策略上限 —— 不是非法输入", () => {
    const z = scaleConstraints(base, 0);
    expect(z.slippage).toBe(0);
    expect(z.feeRate).toBe(0);
    expect(z.minFee).toBe(0);
  });

  it("×2 三项成本一起翻倍，A股约束那几个开关不受影响", () => {
    const c = scaleConstraints(base, 2);
    expect(c.slippage).toBeCloseTo(base.slippage * 2, 10);
    expect(c.feeRate).toBeCloseTo(base.feeRate * 2, 10);
    expect(c.minFee).toBeCloseTo(base.minFee * 2, 10);
    expect(c.t1).toBe(base.t1);
    expect(c.limitUpUnbuyable).toBe(base.limitUpUnbuyable);
  });

  it("levelOf 记下的倍数就是交给 run 的那个", () => {
    const seen: number[] = [];
    costStress(base, (lv) => { seen.push(lv.multiplier); return runner(() => 0.1)(lv); }, [1, 0, 2]);
    expect(seen).toEqual([0, 1, 2]);
  });
});

describe("成本压力测试判定", () => {
  it("极脆弱：现行 7%，成本涨不到一半就归零", () => {
    const r = costStress(base, runner((m) => (m === 0 ? 0.2 : m === 1 ? 0.07 : -0.01)), [0, 1, 1.5]);
    // 手算：1 → +0.07、1.5 → −0.01，零点 = 1 + 0.5 × 0.07/0.08 = 1.4375
    expect(r.breakevenMultiplier).toBeCloseTo(1.4375, 4);
    expect(r.breakevenMultiplier!).toBeLessThan(VERY_FRAGILE_AT);
    expect(r.verdict).toBe("veryFragile");
    expect(r.baseline!.totalReturn).toBeCloseTo(0.07, 4);
  });

  it("脆弱：归零点在 1.5 与 2.5 之间", () => {
    const r = costStress(base, runner((m) => (m === 0 ? 0.3 : m === 1 ? 0.1 : m === 2 ? 0.02 : -0.05)), [0, 1, 2, 3]);
    expect(r.breakevenMultiplier!).toBeGreaterThanOrEqual(VERY_FRAGILE_AT);
    expect(r.breakevenMultiplier!).toBeLessThan(FRAGILE_AT);
    expect(r.verdict).toBe("fragile");
  });

  it("稳健：到 ×3 仍未归零，且确实测过了 ×2.5 以上", () => {
    const r = costStress(base, runner((m) => 0.2 - 0.05 * m), [0, 1, 2, 3]);
    expect(r.breakevenMultiplier).toBeNull();
    expect(r.neverBreaks).toBe(true);
    expect(r.verdict).toBe("robust");
  });

  it("没测到边界就不许说稳健 —— 只测到 ×1.5，判脆弱", () => {
    const r = costStress(base, runner(() => 0.1), [0, 1, 1.5]);
    expect(r.breakevenMultiplier).toBeNull();
    expect(r.verdict).toBe("fragile");
    expect(r.note).toContain("没测到边界");
    expect(r.note).toContain(String(ROBUST_NEEDS));
  });

  it("现行成本下就不赚钱 —— 别去讨论成本再涨会怎样", () => {
    const r = costStress(base, runner((m) => (m === 0 ? 0.1 : m === 1 ? -0.02 : -0.1)), [0, 1, 2]);
    expect(r.verdict).toBe("unprofitable");
    expect(r.note).toContain("就已经不赚钱");
  });

  it("零摩擦都不赚钱：这是策略的问题，不许甩锅给成本", () => {
    const r = costStress(base, runner((m) => -0.02 - 0.01 * m), [0, 1, 2]);
    expect(r.verdict).toBe("unprofitable");
    expect(r.note).toContain("不是成本问题");
    expect(r.costShare).toBeNull();
  });

  it("档位不足时如实说判不出，不默认成稳健", () => {
    const r = costStress(base, runner(() => 0.1), [1]);
    expect(r.verdict).toBe("undecidable");
    expect(r.breakevenMultiplier).toBeNull();
    expect(r.neverBreaks).toBe(false);
  });

  it("没跑现行那一档（×1），照样判不出", () => {
    const r = costStress(base, runner((m) => (m === 0 ? 0.2 : -0.01)), [0, 2]);
    expect(r.baseline).toBeNull();
    expect(r.verdict).toBe("undecidable");
    expect(r.note).toContain("×1");
  });

  it("不外推：所有档都赚时给 null，不猜一个更高的数", () => {
    const r = costStress(base, runner(() => 0.15), [0, 1]);
    expect(r.breakevenMultiplier).toBeNull();
    expect(r.neverBreaks).toBe(true);
  });
});

describe("成本占比与排序", () => {
  it("成本吃掉的比例：零摩擦 20% → 现行 7%，吃掉 65%", () => {
    const r = costStress(base, runner((m) => (m === 0 ? 0.2 : m === 1 ? 0.07 : 0.03)), [0, 1, 2]);
    expect(r.costShare).toBeCloseTo(0.65, 4);
    expect(r.note).toContain("65.0%");
  });

  it("档位去重并按倍数升序，重复与乱序都不影响判定", () => {
    const r = costStress(base, runner((m) => (m === 0 ? 0.2 : m === 1 ? 0.07 : -0.01)), [2, 1, 0, 1]);
    expect(r.points.map((p) => p.level.multiplier)).toEqual([0, 1, 2]);
  });

  it("负数倍数与非数字被丢掉，不是当成 0 混进来", () => {
    const r = costStress(base, runner(() => 0.1), [1, -1, Number.NaN]);
    expect(r.points.map((p) => p.level.multiplier)).toEqual([1]);
  });
});

describe("断点续跑：判定与跑测分开", () => {
  it("toStressPoint 能把一次回测直接折成档位点，不必走 run", () => {
    const lv = levelOf(base, 1);
    const p = toStressPoint(lv, runner(() => 0.12)(lv));
    expect(p.level.multiplier).toBe(1);
    expect(p.totalReturn).toBeCloseTo(0.12, 4);
    expect(p.degenerated).toBe(false);
  });

  it("落盘的档位点能还原出同一个判定", () => {
    const net = (m: number) => (m === 0 ? 0.2 : m === 1 ? 0.07 : -0.01);
    const direct = costStress(base, runner(net), [0, 1, 1.5]);
    // 模拟"上次跑到一半崩了，点已经落盘"：只拿纯数值的点重新判定
    const restored = evaluateCostStress(
      direct.points.map((p) => JSON.parse(JSON.stringify(p)) as typeof p)
    );
    expect(restored.verdict).toBe(direct.verdict);
    expect(restored.breakevenMultiplier).toBeCloseTo(direct.breakevenMultiplier!, 6);
    expect(restored.costShare).toBeCloseTo(direct.costShare!, 6);
  });

  it("乱序的档位点也能判对，不依赖写入顺序", () => {
    const net = (m: number) => (m === 0 ? 0.3 : m === 1 ? 0.1 : m === 2 ? 0.02 : -0.05);
    const pts = costStress(base, runner(net), [0, 1, 2, 3]).points;
    const shuffled = [pts[3], pts[1], pts[0], pts[2]].map((p) => JSON.parse(JSON.stringify(p)) as typeof p);
    const r = evaluateCostStress(shuffled);
    expect(r.verdict).toBe("fragile");
    // 光看 verdict 会因为凑巧蒙对：归零点和最高档必须按排好序的档位算
    expect(r.breakevenMultiplier).toBeCloseTo(2 + 0.02 / 0.07, 3);
    expect(r.points.map((p) => p.level.multiplier)).toEqual([0, 1, 2, 3]);
    expect(r.frictionless?.level.multiplier).toBe(0);
  });

  it("续跑追加的档位排在旧档后面：全盈利、已测到 ×3 → 稳健，不是脆弱", () => {
    const net = (m: number) => (m === 0 ? 0.3 : m === 1 ? 0.2 : m === 1.5 ? 0.15 : 0.05);
    const pts = costStress(base, runner(net), [0, 1, 1.5, 3]).points;
    // 落盘顺序 [0, 1, 3, 1.5]：先跑了 0/1/3，崩了，续跑补了 1.5
    const resumed = [pts[0], pts[1], pts[3], pts[2]].map((p) => JSON.parse(JSON.stringify(p)) as typeof p);
    const r = evaluateCostStress(resumed);
    expect(r.breakevenMultiplier).toBeNull();
    expect(r.neverBreaks).toBe(true);
    expect(r.verdict).toBe("robust");
    expect(r.note).toContain("×3");
  });

  it("续跑追加的档位：[0,1,3(-5%),2(+4%)] 归零点在 2~3 之间插值 ≈2.44", () => {
    const net = (m: number) => (m === 0 ? 0.3 : m === 1 ? 0.1 : m === 2 ? 0.04 : -0.05);
    const pts = costStress(base, runner(net), [0, 1, 2, 3]).points;
    const resumed = [pts[0], pts[1], pts[3], pts[2]].map((p) => JSON.parse(JSON.stringify(p)) as typeof p);
    const r = evaluateCostStress(resumed);
    // 乱序时会在 1→3 之间插出 2.33，这是错的
    expect(r.breakevenMultiplier).toBeCloseTo(2 + 0.04 / 0.09, 3);
    expect(r.verdict).toBe("fragile");
  });

  it("缺了现行那一档就判不出，不会因为已有加压档就糊出一个结论", () => {
    const net = (m: number) => (m === 0 ? 0.2 : -0.01);
    const pts = costStress(base, runner(net), [0, 2]).points.map((p) => JSON.parse(JSON.stringify(p)) as typeof p);
    const r = evaluateCostStress(pts);
    expect(r.baseline).toBeNull();
    expect(r.verdict).toBe("undecidable");
  });
});

describe("退化与空数据如实标注", () => {
  it("样本不足那一档被标退化，并在结论里点名", () => {
    const r = costStress(base, runner(() => 0.1, { trades: MIN_SAMPLE_TRADES - 1 }), [0, 1]);
    expect(r.points.every((p) => p.degenerated)).toBe(true);
    expect(r.note).toContain("退化");
  });

  it("空净值曲线不冒充 0 收益 —— 那是没跑出来", () => {
    const r = costStress(base, () => ({
      metrics: {
        calmar: 0, annualReturn: 0, maxDrawdown: 0, sharpe: 0, winRate: 0,
        profitFactor: 0, trades: 0, avgHoldDays: 0, triggerRate: null,
        buyDecisions: 0, buyFilled: 0,
      },
      equity: [],
    }), [0, 1]);
    expect(r.points[0].totalReturn).toBe(0);
    expect(r.verdict).toBe("unprofitable");
  });

  it("区间短于门槛时同样算退化，与 metrics 那个判据同一个常量", () => {
    const r = costStress(base, runner(() => 0.1, { days: MIN_SAMPLE_DAYS - 1, trades: 500 }), [0, 1]);
    expect(r.points[0].degenerated).toBe(true);
  });
});
