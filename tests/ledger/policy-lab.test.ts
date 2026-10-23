import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { Db } from "@/lib/db";
import {
  loadLongSamples, loadSampleBars, loocv, replayTrade, scorePolicy, simulateExit,
  type ExitRule, type SampleBars,
} from "@/lib/ledger/policy-lab";
import { recordPrediction } from "@/lib/ledger/record";
import type { AdjBar } from "@/lib/ledger/reconcile";
import { cleanup, mkPred, seedCalendar, seedDaily, tmpDb, weekdays } from "./helpers";

let db: Db, dir: string, days: string[];
beforeEach(() => {
  ({ db, dir } = tmpDb());
  days = weekdays("2026-08-03", 40);
  seedCalendar(db, days);
});
afterEach(() => cleanup(db, dir));

const bar = (date: string, o: number, h: number, l: number, c: number): AdjBar =>
  ({ date, o, h, l, c });

const HOLD: ExitRule = { takeProfitPct: null, stopPct: null, trailPct: null };

describe("ledger/policy-lab 离场模拟", () => {
  it("止盈按挂单价成交，跳空高开则按开盘价 —— 不能拿挂单价卖一笔更贵的", () => {
    const bars = [bar("d1", 10, 10.6, 9.9, 10.4), bar("d2", 11, 11.2, 10.9, 11)];
    const a = simulateExit(bars, 10, { takeProfitPct: 5, stopPct: null, trailPct: null });
    expect(a!.reason).toBe("止盈");
    expect(a!.pct).toBeCloseTo(5, 6);
    // 第二根开盘 11 已越过 10.5 → 按 11 卖，+10% 而不是 +5%
    const b = simulateExit(bars.slice(1), 10, { takeProfitPct: 5, stopPct: null, trailPct: null });
    expect(b!.pct).toBeCloseTo(10, 6);
  });

  it("同一根 K 线同时够到两条线时按止损算 —— 往不利的一边猜", () => {
    const bars = [bar("d1", 10, 10.6, 8.9, 9.5)];
    const r = simulateExit(bars, 10, { takeProfitPct: 5, stopPct: 10, trailPct: null });
    expect(r!.reason).toBe("止损");
    expect(r!.pct).toBeCloseTo(-10, 6);
  });

  it("移动止损自峰值回撤计，峰值单调不减", () => {
    const bars = [
      bar("d1", 10, 12, 11.5, 11.5),     // 峰值抬到 12，当日最低 11.5 未破 11.4
      bar("d2", 11, 11.2, 11.3, 11),     // 12×0.95=11.4，最低 11.3 ≤ 11.4 → 出
    ];
    const r = simulateExit(bars, 10, { takeProfitPct: null, stopPct: null, trailPct: 5 });
    expect(r!.reason).toBe("移动止损");
    expect(r!.date).toBe("d2");
  });

  it("都没有触发就按末日收盘离场", () => {
    const bars = [bar("d1", 10, 10.2, 9.8, 10), bar("d2", 10, 10.1, 9.9, 10.3)];
    const r = simulateExit(bars, 10, { takeProfitPct: 20, stopPct: 20, trailPct: null });
    expect(r!.reason).toBe("期满");
    expect(r!.pct).toBeCloseTo(3, 6);
  });
});

describe("ledger/policy-lab 入场重放", () => {
  function oneSample(): SampleBars {
    // 基准日 08-03 收 10；08-04 盘中最低 9.0；08-05 起回升
    seedDaily(db, "300502", [
      { date: "2026-08-03", c: 10 },
      { date: "2026-08-04", o: 9.8, h: 10, l: 9.0, c: 9.4 },
      { date: "2026-08-05", o: 9.5, h: 10.2, l: 9.4, c: 10.1 },
      { date: "2026-08-06", c: 10.1 },
      { date: "2026-08-07", c: 10.1 },
      { date: "2026-08-10", c: 10.1 },
    ]);
    recordPrediction(db, mkPred({
      id: "s1", ts: "2026-08-03T15:30:00+08:00", triggerPx: 9.5, stopPx: null, validUntil: "2026-08-10",
    }));
    // loadLongSamples 走 prediction JOIN outcome：台账行必须先结算过（未成交也是结算结果）
    db.prepare(
      `INSERT INTO outcome (pred_id, verdict, actual_pct, attribution, settled_at)
       VALUES ('s1', '中性', NULL, 'test', '2026-08-11T00:00:00.000Z')`
    ).run();
    const samples = loadLongSamples(db);
    const all = loadSampleBars(db, samples);
    expect(all).toHaveLength(1);
    return all[0];
  }

  it("折让单挂太低就不成交，收益记 0 —— 没建仓不该有盈亏", () => {
    const sb = oneSample();
    const r = replayTrade(sb, { discountPct: 20, windowDays: 3 }, HOLD)!;
    expect(r.triggered).toBe(false);
    expect(r.pct).toBe(0);
    expect(r.entryPx).toBeNull();
  });

  it("折让单成交取 min(开盘价, 触发价) —— 低开时以更好的开盘价成交", () => {
    const sb = oneSample();
    // 折让 8% → 触发价 9.2；08-04 最低 9.0 够到，开盘 9.8 更高 → 成交 9.2
    const r = replayTrade(sb, { discountPct: 8, windowDays: 3 }, HOLD)!;
    expect(r.triggered).toBe(true);
    expect(r.entryPx).toBeCloseTo(9.2, 6);
  });

  it("T+1：成交当日不能离场，最早次日 —— 漏掉它会把止盈规则做高", () => {
    // 成交当日最高 10（触发价 9.5 之上），止盈 5% 的线是 9.5×1.05=9.975，当日就够到了
    const sb = oneSample();
    const r = replayTrade(sb, { discountPct: 5, windowDays: 3 },
      { takeProfitPct: 5, stopPct: null, trailPct: null })!;
    expect(r.triggered).toBe(true);
    // 成交日 08-04，当日最低 9.0 ≤ 9.5×0.95=9.025 也够到过止盈线
    // 但 T+1 只能等到 08-05：开盘 9.5 ≥ 9.975? 不是；最高 10.2 ≥ 9.975 → 次日按 9.975 走
    expect(r.exit!.date).toBe("2026-08-05");
  });

  it("未成交的样本留在分母里 —— 每信号期望不能被成交的那批独占", () => {
    const sb = oneSample();
    const s = scorePolicy([sb], { discountPct: 20, windowDays: 3 }, HOLD);
    expect(s.n).toBe(1);
    expect(s.filled).toBe(0);
    expect(s.meanPct).toBe(0);
    expect(s.fillRate).toBe(0);
  });
});

describe("ledger/policy-lab 留一法", () => {
  it("每折只在其余样本上选参数，折数等于样本数", () => {
    const all: SampleBars[] = [];
    for (let i = 0; i < 3; i++) {
      const code = `30050${i}`;
      seedDaily(db, code, [
        { date: days[0], c: 10 },
        { date: days[1], o: 10, h: 10.1, l: 9.9, c: 10 },
        { date: days[2], o: 10, h: 10.3, l: 9.9, c: 10.2 },
        { date: days[3], c: 10.2 },
        { date: days[4], c: 10.2 },
        { date: days[5], c: 10.2 },
      ]);
      all.push({
        sample: {
          predId: `x${i}`, code, action: "买入", horizon: 5, base: days[0],
          entryPx: null, entryDate: null, holdFrom: null, horizonEnd: days[5],
          triggerPxAdj: 10,
        },
        basePx: 10, triggerPxAdj: 10,
        bars: [
          { date: days[1], o: 10, h: 10.1, l: 9.9, c: 10 },
          { date: days[2], o: 10, h: 10.3, l: 9.9, c: 10.2 },
          { date: days[3], o: 10.2, h: 10.2, l: 10.1, c: 10.2 },
          { date: days[4], o: 10.2, h: 10.2, l: 10.1, c: 10.2 },
          { date: days[5], o: 10.2, h: 10.2, l: 10.1, c: 10.2 },
        ],
        ret5: 0, ret10: 0,
      });
    }
    const r = loocv(all, [null, 5], [1, 3], [HOLD, { takeProfitPct: 2, stopPct: null, trailPct: null }]);
    expect(r.folds).toHaveLength(3);
    expect(r.chosenCounts.reduce((a, c) => a + c.times, 0)).toBe(3);
    expect(Number.isFinite(r.meanPct)).toBe(true);
  });
});
