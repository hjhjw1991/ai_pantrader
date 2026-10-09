/**
 * 台账结算口径的两处修正（用户 2026-10-09 选定）：
 *   1. 决策晚于成交日 09:25 → 作废：不进胜率 / 复盘 / 仪表盘的任何分母或计数，只在时间线留痕
 *   2. 进场方式：突破（触价）按"最高 ≥ 触发价、价 = max(开盘, 触发价)"撮合，一字涨停买不进；
 *      低吸（缺省）口径不变
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { Db } from "@/lib/db";
import { reconcile, settleOne } from "@/lib/ledger/reconcile";
import { getPrediction, recordPrediction } from "@/lib/ledger/record";
import { winRate } from "@/lib/ledger/winrate";
import { review } from "@/lib/ledger/review";
import { hitRateByPeriod, pendingSummary, predictionTimeline } from "@/lib/ledger/dashboard";
import { isLateDecision, toShanghaiWall } from "@/lib/data/clock";
import { cleanup, mkPred, seedCalendar, seedDaily, tmpDb, weekdays } from "./helpers";

let db: Db, dir: string;
beforeEach(() => {
  ({ db, dir } = tmpDb());
  seedCalendar(db, weekdays("2026-08-03", 40));
});
afterEach(() => cleanup(db, dir));

/** 08-04 成交日：开 10、低 9.9 —— 低吸触发价 10 一定成交；08-10 收 11（+10%，命中） */
const seedGood = () => seedDaily(db, "300502", [
  { date: "2026-08-03", c: 10 },
  { date: "2026-08-04", o: 10, h: 10.2, l: 9.9, c: 10.1 },
  { date: "2026-08-10", c: 11 },
]);

describe("toShanghaiWall / isLateDecision", () => {
  it("带偏移 / Z 的按时区换算，不带的视为上海挂钟", () => {
    expect(toShanghaiWall("2026-08-04T09:15:00+08:00")).toBe("2026-08-04 09:15:00");
    expect(toShanghaiWall("2026-08-04T01:30:00.000Z")).toBe("2026-08-04 09:30:00");
    expect(toShanghaiWall("2026-08-04 11:00:00.123")).toBe("2026-08-04 11:00:00");
    expect(toShanghaiWall("2026-08-04")).toBe("2026-08-04 00:00:00");
  });
  it("09:25:00 整算晚（撮合已发生），09:24:59 不算；前一天盘后的永远不晚", () => {
    expect(isLateDecision("2026-08-04 09:25:00", "2026-08-04")).toBe(true);
    expect(isLateDecision("2026-08-04 09:24:59.999", "2026-08-04")).toBe(false);
    expect(isLateDecision("2026-08-03T15:30:00+08:00", "2026-08-04")).toBe(false);
    expect(isLateDecision("2026-08-04T01:26:00Z", "2026-08-04")).toBe(true);
  });
});

describe("晚决策作废", () => {
  it("盘前计划 11:00 才跑：成交日开盘前的低点不可得 → 作废，不需要任何价格", () => {
    // 不铺日线：作废不该因为缺价卡在 pending
    const p = mkPred({ id: "late", phase: "盘中", ts: "2026-08-04 11:00:00.000", validUntil: "2026-08-10" });
    const att = settleOne(db, p);
    expect(att.ok).toBe(true);
    expect(att.outcome).toMatchObject({
      verdict: "作废", actualPct: null, triggered: null, entryPx: null, entryDate: null, errorType: null,
    });
    expect(att.outcome!.attribution).toContain("决策晚于成交日 09:25");
  });

  it("09:15 准点跑的照常结算", () => {
    seedGood();
    const att = settleOne(db, mkPred({ phase: "盘前", ts: "2026-08-04T09:15:00+08:00" }));
    expect(att.outcome!.verdict).toBe("命中");
  });

  it("作废不进胜率 / 复盘 / 仪表盘，但留在时间线上", () => {
    seedGood();
    recordPrediction(db, mkPred({ id: "ok", phase: "盘前", ts: "2026-08-04T09:15:00+08:00" }));
    recordPrediction(db, mkPred({ id: "late", phase: "盘中", ts: "2026-08-05T11:00:00+08:00", code: "300502" }));
    const rep = reconcile(db, { asOf: "2026-08-20" });
    expect(Object.fromEntries(rep.settled.map(o => [o.predId, o.verdict]))).toMatchObject({ ok: "命中", late: "作废" });

    const w = winRate(db);
    expect(w).toMatchObject({ total: 1, hit: 1, settled: 1, neutral: 0, untriggered: 0 });
    const rv = review(db);
    expect(rv.settled).toBe(1);
    expect(rv.triggerable).toBe(1);
    expect(hitRateByPeriod(db).map(r => r.period)).toEqual(["2026-08-04"]);
    expect(pendingSummary(db, "2026-08-20")).toMatchObject({ settled: 1, pending: 0 });
    const tl = predictionTimeline(db);
    expect(tl.find(r => r.predId === "late")).toMatchObject({ settled: true, verdict: "作废" });
  });

  it("按老口径已经结算过的晚决策：下次对账原地改判作废（幂等）", () => {
    seedGood();
    recordPrediction(db, mkPred({ id: "late", phase: "盘中", ts: "2026-08-04T10:00:00+08:00" }));
    db.prepare(
      `INSERT INTO outcome (pred_id, verdict, actual_pct, error_type, attribution, settled_at, triggered, entry_px, entry_date)
       VALUES ('late', '命中', 10, NULL, '老口径', 'x', 1, 10, '2026-08-04')`
    ).run();
    expect(winRate(db).total).toBe(1);

    const rep = reconcile(db, { asOf: "2026-08-20", now: "2026-08-20T00:00:00.000Z" });
    expect(rep.revoided).toBe(1);
    const row = db.prepare("SELECT * FROM outcome WHERE pred_id = 'late'").get() as any;
    expect(row).toMatchObject({ verdict: "作废", actual_pct: null, triggered: null, entry_px: null, entry_date: null });
    expect(winRate(db).total).toBe(0);
    expect(reconcile(db, { asOf: "2026-08-21" }).revoided).toBe(0);
  });
});

describe("进场方式：突破", () => {
  const bo = (over = {}) => mkPred({ id: "bo", triggerPx: 11, stopPx: 10.2, entryType: "突破", ...over });

  it("entryType 落库、读回；缺省读回低吸", () => {
    recordPrediction(db, bo());
    recordPrediction(db, mkPred({ id: "dflt" }));
    expect(getPrediction(db, "bo")!.entryType).toBe("突破");
    expect(getPrediction(db, "dflt")!.entryType).toBe("低吸");
    // 不带字段与显式低吸是同一内容：重投不算改写
    expect(() => recordPrediction(db, mkPred({ id: "dflt", entryType: "低吸" }))).not.toThrow();
  });

  it("最高价没摸到触发价 → 未触发（低吸口径下这笔会以开盘价成交）", () => {
    seedDaily(db, "300502", [
      { date: "2026-08-03", c: 10 }, { date: "2026-08-04", o: 10.2, h: 10.8, l: 10.1, c: 10.5 }, { date: "2026-08-10", c: 12 },
    ]);
    expect(settleOne(db, bo()).outcome).toMatchObject({ verdict: "未触发", triggered: false });
    expect(settleOne(db, bo({ entryType: "低吸" })).outcome).toMatchObject({ triggered: true, entryPx: 10.2 });
  });

  it("盘中涨到触发价 → 按触发价；跳空高开 → 按开盘价", () => {
    seedDaily(db, "300502", [
      { date: "2026-08-03", c: 10 }, { date: "2026-08-04", o: 10.5, h: 11.2, l: 10.4, c: 11 }, { date: "2026-08-10", c: 12 },
    ]);
    expect(settleOne(db, bo()).outcome).toMatchObject({ triggered: true, entryPx: 11, entryDate: "2026-08-04" });
    seedDaily(db, "300502", [{ date: "2026-08-04", o: 11.05, h: 11.2, l: 11, c: 11.1 }]);
    expect(settleOne(db, bo()).outcome!.entryPx).toBe(11.05);
  });

  it("一字涨停 → 未触发；摸板后封死（非一字）→ 按涨停价成交", () => {
    seedDaily(db, "300502", [
      { date: "2026-08-03", c: 10 }, { date: "2026-08-04", o: 11, h: 11, l: 11, c: 11 }, { date: "2026-08-10", c: 12 },
    ]);
    expect(settleOne(db, bo()).outcome).toMatchObject({ verdict: "未触发", triggered: false });
    seedDaily(db, "300502", [{ date: "2026-08-04", o: 10.4, h: 11, l: 10.3, c: 11 }]);
    expect(settleOne(db, bo()).outcome).toMatchObject({ triggered: true, entryPx: 11 });
  });
});
