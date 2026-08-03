import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { Db } from "@/lib/db";
import {
  NEUTRAL_BAND_PCT,
  baseTradingDay,
  directionOf,
  lhbLabelPct,
  reconcile,
  settleOne,
  tradingDayOffset,
} from "@/lib/ledger/reconcile";
import { recordPrediction } from "@/lib/ledger/record";
import { cleanup, mkPred, seedCalendar, seedDaily, seedSnapshot, tmpDb, weekdays } from "./helpers";

let db: Db, dir: string, days: string[];
beforeEach(() => {
  ({ db, dir } = tmpDb());
  days = weekdays("2026-08-03", 40);
  seedCalendar(db, days);
});
afterEach(() => cleanup(db, dir));

describe("ledger/reconcile 交易日推进", () => {
  it("按交易日而不是自然日推进 —— 跨周末不能多算两天", () => {
    // days[0]=周一 2026-08-03，第 5 个交易日应是次周一 08-10
    expect(days[0]).toBe("2026-08-03");
    expect(tradingDayOffset(db, "2026-08-03", 5)).toBe("2026-08-10");
    expect(tradingDayOffset(db, "2026-08-03", 1)).toBe("2026-08-04");
    // 日历不够长 → null，不许用自然日兜
    expect(tradingDayOffset(db, days[days.length - 2], 5)).toBeNull();
  });

  it("基准日随 phase 变：盘后用当日收盘，盘前/盘中只能用上一交易日收盘", () => {
    expect(baseTradingDay(db, mkPred({ phase: "盘后", ts: "2026-08-04T15:30:00+08:00" })))
      .toBe("2026-08-04");
    // 盘前/盘中做的判断，当日收盘还没发生，拿它当基准就是用了未来价
    expect(baseTradingDay(db, mkPred({ phase: "盘前", ts: "2026-08-04T09:15:00+08:00" })))
      .toBe("2026-08-03");
    expect(baseTradingDay(db, mkPred({ phase: "盘中", ts: "2026-08-04T10:30:00+08:00" })))
      .toBe("2026-08-03");
  });
});

describe("ledger/reconcile 结算", () => {
  it("有日线时用日线收盘结算，看涨超中性带记命中", () => {
    seedDaily(db, "300502", [{ date: "2026-08-03", c: 10 }, { date: "2026-08-10", c: 11 }]);
    recordPrediction(db, mkPred({ id: "d1", evalHorizon: 5, validUntil: "2026-08-10" }));

    const rep = reconcile(db, { asOf: "2026-08-11" });
    expect(rep.skipped).toEqual([]);
    expect(rep.settled).toHaveLength(1);
    expect(rep.settled[0].actualPct).toBeCloseTo(10, 6);
    expect(rep.settled[0].verdict).toBe("命中");
    expect(rep.settled[0].attribution).toContain("kline_daily");

    const row = db.prepare("SELECT * FROM outcome WHERE pred_id='d1'").get() as any;
    expect(row.verdict).toBe("命中");
    expect(row.actual_pct).toBeCloseTo(10, 6);
  });

  it("horizon 末日没有日线时退回 quote_snapshot", () => {
    seedDaily(db, "300502", [{ date: "2026-08-03", c: 10 }]);
    // 08-04 只有快照没有日线（当日收盘日线尚未落库）
    seedSnapshot(db, "2026-08-04T06:00:00.000Z", "300502", 10.2);
    seedSnapshot(db, "2026-08-04T07:05:00.000Z", "300502", 10.5);
    recordPrediction(db, mkPred({ id: "s1", evalHorizon: 1, validUntil: "2026-08-04" }));

    const rep = reconcile(db, { asOf: "2026-08-05" });
    expect(rep.settled).toHaveLength(1);
    // 取当日最后一笔快照
    expect(rep.settled[0].actualPct).toBeCloseTo(5, 6);
    expect(rep.settled[0].attribution).toContain("quote_snapshot");
  });

  it("两个价源都没有时拒绝结算，留 pending 并报出原因 —— 猜价会毁掉整个台账", () => {
    seedDaily(db, "300502", [{ date: "2026-08-03", c: 10 }]);
    recordPrediction(db, mkPred({ id: "n1", evalHorizon: 1, validUntil: "2026-08-04" }));

    const rep = reconcile(db, { asOf: "2026-08-05" });
    expect(rep.settled).toEqual([]);
    expect(rep.skipped).toHaveLength(1);
    expect(rep.skipped[0]).toMatchObject({ predId: "n1", reason: "无收盘价" });
    expect((db.prepare("SELECT COUNT(*) n FROM outcome").get() as any).n).toBe(0);

    // 价格补上之后同一条能结算 —— pending 不是丢弃
    seedDaily(db, "300502", [{ date: "2026-08-04", c: 10.3 }]);
    expect(reconcile(db, { asOf: "2026-08-05" }).settled).toHaveLength(1);
  });

  it("基准日缺价也拒绝结算", () => {
    seedDaily(db, "300502", [{ date: "2026-08-04", c: 10.3 }]);
    recordPrediction(db, mkPred({ id: "n2", evalHorizon: 1, validUntil: "2026-08-04" }));
    const rep = reconcile(db, { asOf: "2026-08-05" });
    expect(rep.skipped[0].reason).toBe("无基准价");
  });

  it("日历还没排到 horizon 末日时不结算，报 日历不足", () => {
    seedDaily(db, "300502", [{ date: days[38], c: 10 }]);
    recordPrediction(db, mkPred({
      id: "c1", ts: `${days[38]}T15:30:00+08:00`, evalHorizon: 30, validUntil: days[39],
    }));
    const rep = reconcile(db, { asOf: "2099-01-01" });
    expect(rep.skipped[0]).toMatchObject({ predId: "c1", reason: "日历不足" });
  });

  it("重复结算是幂等的：二次运行不再写、不改已结算的行", () => {
    seedDaily(db, "300502", [{ date: "2026-08-03", c: 10 }, { date: "2026-08-10", c: 11 }]);
    recordPrediction(db, mkPred({ id: "i1", evalHorizon: 5, validUntil: "2026-08-10" }));

    const first = reconcile(db, { asOf: "2026-08-11", now: "2026-08-11T01:00:00.000Z" });
    expect(first.settled).toHaveLength(1);
    const snap = db.prepare("SELECT * FROM outcome").all();

    const second = reconcile(db, { asOf: "2026-08-11", now: "2026-08-12T01:00:00.000Z" });
    expect(second.settled).toEqual([]);
    expect(second.scanned).toBe(0);
    expect(db.prepare("SELECT * FROM outcome").all()).toEqual(snap);
  });

  it("减仓/清仓是看跌方向：跌了算命中，涨了算偏差", () => {
    expect(directionOf("清仓")).toBe("看跌");
    expect(directionOf("买入")).toBe("看涨");
    expect(directionOf("观察")).toBe("中性");

    seedDaily(db, "300502", [{ date: "2026-08-03", c: 10 }, { date: "2026-08-10", c: 9 }]);
    recordPrediction(db, mkPred({ id: "b1", action: "清仓", evalHorizon: 5, validUntil: "2026-08-10" }));
    const rep = reconcile(db, { asOf: "2026-08-11" });
    expect(rep.settled[0].verdict).toBe("命中");
    expect(rep.settled[0].actualPct).toBeCloseTo(-10, 6);
  });

  it("中性带内不判对错，观察类信号一律中性（没有方向承诺）", () => {
    seedDaily(db, "300502", [{ date: "2026-08-03", c: 10 }, { date: "2026-08-10", c: 10.2 }]);
    recordPrediction(db, mkPred({ id: "z1", evalHorizon: 5, validUntil: "2026-08-10" }));
    recordPrediction(db, mkPred({ id: "z2", action: "观察", evalHorizon: 5, validUntil: "2026-08-10" }));
    const rep = reconcile(db, { asOf: "2026-08-11" });
    expect(rep.settled.every(o => o.verdict === "中性")).toBe(true);
    // 中性带按 sqrt(horizon) 放大，D1 最窄
    expect(NEUTRAL_BAND_PCT[1]).toBeLessThan(NEUTRAL_BAND_PCT[30]);
  });

  it("settleOne 记录破止损与破位日期，供归因用", () => {
    seedDaily(db, "300502", [
      { date: "2026-08-03", c: 10 },
      { date: "2026-08-04", c: 9.5, l: 9.4 },
      { date: "2026-08-05", c: 9.2, l: 8.8 },
      { date: "2026-08-10", c: 9.0, l: 9.0 },
    ]);
    const p = mkPred({ id: "st1", stopPx: 9, evalHorizon: 5, validUntil: "2026-08-10" });
    const att = settleOne(db, p, {});
    expect(att.ok).toBe(true);
    expect(att.facts!.stopBreached).toBe(true);
    expect(att.facts!.stopBreachDate).toBe("2026-08-05");
  });

  it("龙虎榜 d5_chg 做交叉校验，上榜当日为 NULL 时必须安全返回 null", () => {
    db.prepare(
      `INSERT INTO lhb (date, code, change_type, d5_chg) VALUES ('2026-08-03','300502','t1',NULL)`
    ).run();
    expect(lhbLabelPct(db, "300502", "2026-08-03", 5)).toBeNull();

    db.prepare(
      `INSERT INTO lhb (date, code, change_type, d5_chg) VALUES ('2026-08-03','300502','t2',9.8)`
    ).run();
    expect(lhbLabelPct(db, "300502", "2026-08-03", 5)).toBeCloseTo(9.8, 6);
  });
});
