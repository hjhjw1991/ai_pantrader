import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { Db } from "@/lib/db";
import {
  errorTypeBreakdown,
  hitRateByPeriod,
  hitRateByStock,
  ledgerDashboard,
  pendingSummary,
  predictionTimeline,
} from "@/lib/ledger/dashboard";
import { cleanup, insertPredRow, mkPred, seedSettled, tmpDb } from "./helpers";

let db: Db, dir: string;
beforeEach(() => { ({ db, dir } = tmpDb()); });
afterEach(() => cleanup(db, dir));

describe("ledger/dashboard", () => {
  it("按日出命中率", () => {
    seedSettled(db, 2, { idPrefix: "a", hits: 2, advisorInfluenced: false, ts: "2026-08-03T15:30:00+08:00" });
    seedSettled(db, 2, { idPrefix: "b", hits: 0, advisorInfluenced: false, ts: "2026-08-04T15:30:00+08:00" });

    const rows = hitRateByPeriod(db, { granularity: "day" });
    expect(rows).toEqual([
      { period: "2026-08-03", total: 2, hit: 2, miss: 0, neutral: 0, rate: 1 },
      { period: "2026-08-04", total: 2, hit: 0, miss: 2, neutral: 0, rate: 0 },
    ]);
  });

  it("按月/按周聚合", () => {
    seedSettled(db, 1, { idPrefix: "j", hits: 1, advisorInfluenced: false, ts: "2026-07-31T15:30:00+08:00" });
    seedSettled(db, 1, { idPrefix: "k", hits: 0, advisorInfluenced: false, ts: "2026-08-03T15:30:00+08:00" });

    expect(hitRateByPeriod(db, { granularity: "month" }).map(r => r.period))
      .toEqual(["2026-07", "2026-08"]);
    // 周按所在周一归组
    expect(hitRateByPeriod(db, { granularity: "week" }).map(r => r.period))
      .toEqual(["2026-07-27", "2026-08-03"]);
  });

  it("按标的出命中率与平均涨跌幅", () => {
    seedSettled(db, 3, { idPrefix: "x", hits: 2, advisorInfluenced: false, code: "300502" });
    seedSettled(db, 1, { idPrefix: "y", hits: 0, advisorInfluenced: false, code: "002131" });
    db.prepare("INSERT INTO security (code, name) VALUES ('300502','新易盛')").run();

    const rows = hitRateByStock(db);
    expect(rows[0]).toMatchObject({ code: "300502", name: "新易盛", total: 3, hit: 2 });
    expect(rows[0].rate).toBeCloseTo(2 / 3, 6);
    expect(rows[0].avgActualPct).toBeCloseTo((8 + 8 - 6) / 3, 6);
    expect(rows[1]).toMatchObject({ code: "002131", name: null, total: 1, hit: 0 });
  });

  it("按错误类型出频次与占比，五类键齐全", () => {
    seedSettled(db, 3, { idPrefix: "e", hits: 0, advisorInfluenced: false, errorType: "追高" });
    seedSettled(db, 1, { idPrefix: "f", hits: 0, advisorInfluenced: false, errorType: "逆势扛" });

    const rows = errorTypeBreakdown(db);
    expect(rows).toHaveLength(5);
    expect(rows[0]).toMatchObject({ errorType: "追高", count: 3 });
    expect(rows[0].share).toBeCloseTo(0.75, 6);
    expect(rows.find(r => r.errorType === "板块漏扫")).toMatchObject({ count: 0, share: 0 });
  });

  it("时间线把已结算与未结算放在一条轴上，未结算的实际值为 null", () => {
    seedSettled(db, 1, { idPrefix: "s", hits: 1, advisorInfluenced: true });
    insertPredRow(db, mkPred({ id: "pending", ts: "2026-08-04T09:15:00+08:00", action: "清仓" }));

    const tl = predictionTimeline(db);
    expect(tl.map(t => t.predId)).toEqual(["s0", "pending"]);
    expect(tl[0]).toMatchObject({
      verdict: "命中", advisorInfluenced: true, expectedDirection: "看涨", settled: true,
    });
    expect(tl[0].actualPct).toBeCloseTo(8, 6);
    expect(tl[1]).toMatchObject({
      predId: "pending", verdict: null, actualPct: null, errorType: null,
      expectedDirection: "看跌", settled: false,
    });
  });

  it("pendingSummary 区分未到期与已到期未结算（后者是要人看的）", () => {
    insertPredRow(db, mkPred({ id: "due", validUntil: "2026-08-04" }));
    insertPredRow(db, mkPred({ id: "later", validUntil: "2026-09-10" }));
    seedSettled(db, 1, { idPrefix: "done", hits: 1, advisorInfluenced: false });

    expect(pendingSummary(db, "2026-08-05")).toEqual({
      pending: 2, overdueUnsettled: 1, settled: 1,
    });
  });

  it("ledgerDashboard 一次给出前端要的全部切片", () => {
    seedSettled(db, 2, { idPrefix: "d", hits: 1, advisorInfluenced: false });
    const dash = ledgerDashboard(db, { asOf: "2026-08-11", granularity: "day" });
    expect(dash.asOf).toBe("2026-08-11");
    expect(dash.overall.total).toBe(2);
    expect(dash.byPeriod).toHaveLength(1);
    expect(dash.byStock).toHaveLength(1);
    expect(dash.byErrorType).toHaveLength(5);
    expect(dash.timeline).toHaveLength(2);
    expect(dash.pending.settled).toBe(2);
  });
});
