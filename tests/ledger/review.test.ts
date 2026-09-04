import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { Db } from "@/lib/db";
import { reconcile, resolveEntry, excursion, TRIGGER_WINDOW_DAYS } from "@/lib/ledger/reconcile";
import { recordPrediction } from "@/lib/ledger/record";
import { review, MIN_SAMPLE, WIN_RATE_TARGET } from "@/lib/ledger/review";
import { winRate } from "@/lib/ledger/winrate";
import { cleanup, mkPred, seedCalendar, seedDaily, tmpDb, weekdays } from "./helpers";

let db: Db, dir: string, days: string[];
beforeEach(() => {
  ({ db, dir } = tmpDb());
  days = weekdays("2026-08-03", 60);
  seedCalendar(db, days);
});
afterEach(() => cleanup(db, dir));

/**
 * 这一组测的是复盘要回答的三件事，而且它们必须互相分得开：
 *   到没到买点 / 判得准不准 / 赚赔比多少
 * 三个数会互相掩盖，混成一个就再也看不出策略卡在哪一关。
 */
describe("ledger/review 触发判定", () => {
  it("低点摸到触发价才算够到；成交价取 min(开盘, 触发价)", () => {
    seedDaily(db, "300502", [
      { date: "2026-08-03", c: 10 },
      { date: "2026-08-04", o: 10.4, c: 10.2, l: 9.8 },
    ]);
    const p = mkPred({ triggerPx: 10 });
    const e = resolveEntry(db, p, "2026-08-03", { px: 10, source: "kline_daily", date: "2026-08-03" });
    expect(e).toMatchObject({ triggered: true, date: "2026-08-04" });
    // 高开 10.4，限价 10 —— 成交在 10，不是 10.4
    expect(e!.px).toBeCloseTo(10, 6);
  });

  it("低开时按开盘价成交，不按触发价 —— 否则会系统性少算低开捡到的便宜", () => {
    seedDaily(db, "300502", [
      { date: "2026-08-03", c: 10 },
      { date: "2026-08-04", o: 9.5, c: 9.7, l: 9.4 },
    ]);
    const e = resolveEntry(db, mkPred({ triggerPx: 10 }), "2026-08-03", { px: 10, source: "kline_daily", date: "2026-08-03" });
    expect(e!.px).toBeCloseTo(9.5, 6);
  });

  it("窗口内有行情但没到价 = 真的未触发", () => {
    seedDaily(db, "300502", [
      { date: "2026-08-03", c: 10 },
      { date: "2026-08-04", o: 10.5, c: 10.8, l: 10.4 },   // 一路在触发价之上
    ]);
    const e = resolveEntry(db, mkPred({ triggerPx: 10 }), "2026-08-03", { px: 10, source: "kline_daily", date: "2026-08-03" });
    expect(e).toMatchObject({ triggered: false });
  });

  /**
   * 这条是分界线：停牌/数据缺口不能被算成"未触发"。
   * 混起来会把触发率系统性压低，于是复盘得出"买点定得太高"的结论，
   * 而真相是那几天根本没开盘 —— 按 reconcile 抬头的硬规矩，拿不到真价就不结算。
   */
  it("窗口内没有行情 = 判不了，返回 null 交给上层报 无触发窗口价", () => {
    seedDaily(db, "300502", [{ date: "2026-08-03", c: 10 }]);
    expect(resolveEntry(db, mkPred({ triggerPx: 10 }), "2026-08-03", { px: 10, source: "kline_daily", date: "2026-08-03" }))
      .toBeNull();

    // 基准日与 horizon 末日都有价，唯独触发窗口那天（08-04）没有 ——
    // 只有这样才测得到触发判定这一步，否则先被"无收盘价"拦下
    seedDaily(db, "300502", [{ date: "2026-08-10", c: 11 }]);
    recordPrediction(db, mkPred({ id: "susp", evalHorizon: 5, validUntil: "2026-08-10" }));
    const rep = reconcile(db, { asOf: "2026-08-11" });
    expect(rep.settled).toEqual([]);
    expect(rep.skipped[0]).toMatchObject({ reason: "无触发窗口价" });
  });

  it("没有触发价的动作无条件成交，triggered 记 null 不进触发率分母", () => {
    seedDaily(db, "300502", [
      { date: "2026-08-03", c: 10 },
      { date: "2026-08-04", c: 10.5 },
    ]);
    recordPrediction(db, mkPred({ id: "u1", triggerPx: null, evalHorizon: 1, validUntil: "2026-08-04" }));
    reconcile(db, { asOf: "2026-08-05" });
    const row = db.prepare("SELECT triggered, entry_px FROM outcome WHERE pred_id='u1'").get() as any;
    expect(row.triggered).toBeNull();
    expect(review(db).triggerable).toBe(0);
  });

  it("触发窗口是 1 个交易日，与回测撮合口径一致 —— 两边不一样就没法对比", () => {
    expect(TRIGGER_WINDOW_DAYS).toBe(1);
    seedDaily(db, "300502", [
      { date: "2026-08-03", c: 10 },
      { date: "2026-08-04", o: 11, c: 11, l: 10.9 },   // 窗口日没到价
      { date: "2026-08-05", o: 10, c: 10, l: 9.5 },    // 第二天才到，已经不算
    ]);
    const e = resolveEntry(db, mkPred({ triggerPx: 10 }), "2026-08-03", { px: 10, source: "kline_daily", date: "2026-08-03" });
    expect(e).toMatchObject({ triggered: false });
  });
});

describe("ledger/review 区间极值", () => {
  it("MFE/MAE 用盘中高低点，不用收盘 —— 盘中摸到就是真摸到了", () => {
    seedDaily(db, "300502", [
      { date: "2026-08-04", o: 10, c: 10, h: 12, l: 8 },
      { date: "2026-08-05", o: 10, c: 10, h: 10.5, l: 9.5 },
    ]);
    const e = excursion(db, "300502", "看涨", 10, "2026-08-04", "2026-08-05");
    expect(e.mfePct).toBeCloseTo(20, 4);
    expect(e.maePct).toBeCloseTo(-20, 4);
  });

  it("看跌方向的有利偏移是往下 —— 方向搞反会让防守信号的盈亏比全部算反", () => {
    seedDaily(db, "300502", [{ date: "2026-08-04", o: 10, c: 10, h: 11, l: 8 }]);
    const e = excursion(db, "300502", "看跌", 10, "2026-08-04", "2026-08-04");
    expect(e.mfePct).toBeCloseTo(20, 4);    // 跌到 8 = 有利 20%
    expect(e.maePct).toBeCloseTo(-10, 4);   // 涨到 11 = 不利 10%
  });
});

/** 一条到价且盈利的预测：base → 窗口日成交 → horizon 末日收盘 */
function seedWin(db: Db, id: string, exitC: number): void {
  seedDaily(db, `X${id}`, [
    { date: "2026-08-03", c: 10 },
    { date: "2026-08-04", o: 10, c: 10, h: 10.1, l: 9.9 },
    { date: "2026-08-10", c: exitC, h: exitC, l: exitC },
  ]);
  recordPrediction(db, mkPred({
    id, code: `X${id}`, triggerPx: 10, evalHorizon: 5, validUntil: "2026-08-10",
  }));
}

describe("ledger/review 三关分开报", () => {
  it("未触发不进胜率分母，但进触发率分母 —— 两种病要分得开", () => {
    seedWin(db, "hit1", 12);
    // 没到价的那条：窗口日一路在触发价之上
    seedDaily(db, "Xmiss", [
      { date: "2026-08-03", c: 10 },
      { date: "2026-08-04", o: 11, c: 11, h: 11.2, l: 10.8 },
      { date: "2026-08-10", c: 13, h: 13, l: 13 },
    ]);
    recordPrediction(db, mkPred({
      id: "miss", code: "Xmiss", triggerPx: 10, evalHorizon: 5, validUntil: "2026-08-10",
    }));
    reconcile(db, { asOf: "2026-08-11" });

    const s = review(db);
    expect(s.triggerable).toBe(2);
    expect(s.triggered).toBe(1);
    expect(s.triggerRate).toBeCloseTo(0.5, 6);
    // 胜率只在触发样本里算：分母是 1 不是 2
    expect(s.decided).toBe(1);
    expect(s.winRate).toBeCloseTo(1, 6);
    // winrate.ts 的口径必须一致：未触发单独计数，不混进 neutral
    const w = winRate(db);
    expect(w.total).toBe(1);
    expect(w.untriggered).toBe(1);
    expect(w.neutral).toBe(0);
  });

  it("盈亏比按实际盈亏的符号分组，不按判定 —— 按判定分组是在量中性带宽度", () => {
    seedWin(db, "w1", 12);     // +20%
    seedWin(db, "w2", 11);     // +10%
    seedWin(db, "l1", 9);      // -10%
    reconcile(db, { asOf: "2026-08-11" });

    const s = review(db);
    expect(s.avgWinPct).toBeCloseTo(15, 4);
    expect(s.avgLossPct).toBeCloseTo(-10, 4);
    expect(s.payoffRatio).toBeCloseTo(1.5, 4);
    // 期望值 = (20 + 10 - 10) / 3
    expect(s.expectancyPct).toBeCloseTo(6.6667, 3);
    // 每条发出的推荐期望 = 期望 × 触发率（这里三条全触发）
    expect(s.expectancyPerSignalPct).toBeCloseTo(6.6667, 3);
  });

  it("没有亏损样本时盈亏比给 null，不写 Infinity", () => {
    seedWin(db, "a1", 12);
    reconcile(db, { asOf: "2026-08-11" });
    expect(review(db).payoffRatio).toBeNull();
  });

  it("空台账不编数字：所有比率是 null，不是 0", () => {
    const s = review(db);
    expect(s.triggerRate).toBeNull();
    expect(s.winRate).toBeNull();
    expect(s.payoffRatio).toBeNull();
    expect(s.expectancyPct).toBeNull();
  });

  /**
   * 样本不足时**只说样本不足**，不顺带报一个"目前 100%"——
   * 那个数一旦印在屏幕上就会被当成结论用，而它此刻只是噪声。
   */
  it("样本不到 30 条时不下达标结论", () => {
    seedWin(db, "s1", 12);
    reconcile(db, { asOf: "2026-08-11" });
    const s = review(db);
    expect(s.conclusive).toBe(false);
    expect(s.minSample).toBe(MIN_SAMPLE);
    expect(s.verdict).toContain("样本不足");
    expect(s.verdict).not.toContain("达标");
  });

  it("目标线是 60%，结论里要写清楚达没达标", () => {
    expect(WIN_RATE_TARGET).toBe(0.6);
    for (let i = 0; i < 32; i++) seedWin(db, `m${i}`, i < 20 ? 12 : 9);
    reconcile(db, { asOf: "2026-08-11" });
    const s = review(db);
    expect(s.conclusive).toBe(true);
    expect(s.decided).toBe(32);
    expect(s.winRate).toBeCloseTo(20 / 32, 6);   // 62.5%
    expect(s.verdict).toContain("达标");
    expect(s.verdict).not.toContain("未达标");
  });

  it("胜率达标但触发率很低时要点破：那个胜率是纸上的", () => {
    // 32 条到价且盈利，另外 80 条根本没到价 —— 触发率 28.6%
    for (let i = 0; i < 32; i++) seedWin(db, `t${i}`, 12);
    for (let i = 0; i < 80; i++) {
      seedDaily(db, `Xn${i}`, [
        { date: "2026-08-03", c: 10 },
        { date: "2026-08-04", o: 11, c: 11, h: 11.2, l: 10.8 },
        { date: "2026-08-10", c: 13, h: 13, l: 13 },
      ]);
      recordPrediction(db, mkPred({
        id: `n${i}`, code: `Xn${i}`, triggerPx: 10, evalHorizon: 5, validUntil: "2026-08-10",
      }));
    }
    reconcile(db, { asOf: "2026-08-11" });
    const s = review(db);
    expect(s.triggerRate).toBeCloseTo(32 / 112, 4);
    expect(s.verdict).toContain("触发率");
    expect(s.verdict).toContain("纸上");
    // 综合期望被触发率折过：远低于单条已触发的期望
    expect(s.expectancyPerSignalPct!).toBeLessThan(s.expectancyPct!);
  });
});
