import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { Db } from "@/lib/db";
import {
  NEUTRAL_BAND_PCT,
  baseTradingDay,
  directionOf,
  lhbLabelPct,
  reconcile,
  markDirtySettled,
  resettleStoppedOut,
  settleOne,
  tradingDayOffset,
} from "@/lib/ledger/reconcile";
import { recordPrediction } from "@/lib/ledger/record";
import { cleanup, insertOutcomeRow, insertPredRow, mkPred, seedCalendar, seedDaily, seedSnapshot, tmpDb, weekdays } from "./helpers";

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
    // 08-04 是触发窗口那天：低点摸到 triggerPx 10，成交价 min(开盘, 触发价) = 10
    seedDaily(db, "300502", [
      { date: "2026-08-03", c: 10 },
      { date: "2026-08-04", c: 10.1, l: 9.9 },
      { date: "2026-08-10", c: 11 },
    ]);
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
    // triggerPx 留空 —— 判"到没到买点"需要当日的最高/最低价，快照给不出这两个数。
    // 有触发价的预测在日线落库前一律不结算（见下面"无触发窗口价"那条），
    // 这里要测的是**收盘价源**的退化路径，两件事分开测
    recordPrediction(db, mkPred({ id: "s1", triggerPx: null, evalHorizon: 1, validUntil: "2026-08-04" }));

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
    seedDaily(db, "300502", [
      { date: "2026-08-03", c: 10 },
      { date: "2026-08-04", c: 10.1, l: 9.9 },
      { date: "2026-08-10", c: 11 },
    ]);
    recordPrediction(db, mkPred({ id: "i1", evalHorizon: 5, validUntil: "2026-08-10" }));

    const first = reconcile(db, { asOf: "2026-08-11", now: "2026-08-11T01:00:00.000Z" });
    expect(first.settled).toHaveLength(1);
    const snap = db.prepare("SELECT * FROM outcome").all();

    const second = reconcile(db, { asOf: "2026-08-11", now: "2026-08-12T01:00:00.000Z" });
    expect(second.settled).toEqual([]);
    expect(second.scanned).toBe(0);
    expect(db.prepare("SELECT * FROM outcome").all()).toEqual(snap);
  });

  it("复权脏数据（涨跌幅超连板理论上限）被隔离：降级中性、不进胜率分母、actual_pct 保留", () => {
    // 5 日涨 200%，远超 DIRTY_CAP[5]=160，疑似复权跳变
    seedDaily(db, "300502", [
      { date: "2026-08-03", c: 10 },
      { date: "2026-08-04", c: 10.1, l: 9.9 },
      { date: "2026-08-10", c: 30 },
    ]);
    recordPrediction(db, mkPred({ id: "dirty1", evalHorizon: 5, validUntil: "2026-08-10" }));

    const rep = reconcile(db, { asOf: "2026-08-11" });
    expect(rep.settled).toHaveLength(1);
    expect(rep.settled[0].actualPct).toBeCloseTo(200, 6);
    expect(rep.settled[0].verdict).toBe("中性");
    expect(rep.settled[0].dirtyReason).not.toBeNull();

    const row = db.prepare("SELECT * FROM outcome WHERE pred_id='dirty1'").get() as any;
    expect(row.verdict).toBe("中性");
    expect(row.dirty_reason).not.toBeNull();
    expect(row.actual_pct).toBeCloseTo(200, 6);   // 真实失真值保留，让人眼核查
  });

  it("markDirtySettled 把已结算的脏数据老行就地标脏，且幂等", () => {
    insertPredRow(db, mkPred({ id: "old1", evalHorizon: 5, validUntil: "2026-08-10" }));
    insertOutcomeRow(db, "old1", "命中", 200);

    const n = markDirtySettled(db);
    expect(n).toBe(1);
    const row = db.prepare("SELECT * FROM outcome WHERE pred_id='old1'").get() as any;
    expect(row.verdict).toBe("中性");
    expect(row.dirty_reason).not.toBeNull();
    expect(row.actual_pct).toBeCloseTo(200, 6);

    // 二次跑幂等：已标脏的不再动
    expect(markDirtySettled(db)).toBe(0);
    expect(db.prepare("SELECT verdict FROM outcome WHERE pred_id='old1'").get()).toMatchObject({ verdict: "中性" });
  });

  it("减仓/清仓是看跌方向：跌了算命中，涨了算偏差", () => {
    expect(directionOf("清仓")).toBe("看跌");
    expect(directionOf("买入")).toBe("看涨");
    expect(directionOf("观察")).toBe("中性");

    // 卖方向的限价：最高价摸到 triggerPx 10 才算够到
    seedDaily(db, "300502", [
      { date: "2026-08-03", c: 10 },
      { date: "2026-08-04", c: 9.9, h: 10.1 },
      { date: "2026-08-10", c: 9 },
    ]);
    recordPrediction(db, mkPred({ id: "b1", action: "清仓", evalHorizon: 5, validUntil: "2026-08-10" }));
    const rep = reconcile(db, { asOf: "2026-08-11" });
    expect(rep.settled[0].verdict).toBe("命中");
    expect(rep.settled[0].actualPct).toBeCloseTo(-10, 6);
  });

  it("中性带内不判对错，观察类信号一律中性（没有方向承诺）", () => {
    seedDaily(db, "300502", [
      { date: "2026-08-03", c: 10 },
      { date: "2026-08-04", c: 10.05, l: 9.9 },
      { date: "2026-08-10", c: 10.2 },
    ]);
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

  it("破止损按止损价离场，不按 horizon 末收盘硬扛", () => {
    seedDaily(db, "300502", [
      { date: "2026-08-03", c: 10 },                          // 基准
      { date: "2026-08-04", c: 10.1, o: 10.1, l: 9.9 },       // 入场日：够到买点 10，成交 10
      { date: "2026-08-05", c: 9.2, o: 9.2, h: 9.5, l: 8.5 }, // 破止损 9
      { date: "2026-08-06", c: 8.0 },
      { date: "2026-08-07", c: 7.0 },
      { date: "2026-08-10", c: 6.0 },                         // horizon 末：一路跌到 6
    ]);
    const p = mkPred({ id: "st2", stopPx: 9, evalHorizon: 5, validUntil: "2026-08-10" });
    const att = settleOne(db, p, {});
    expect(att.ok).toBe(true);
    // 止损口径：-10%（9 离场）；硬扛口径：-40%（6 离场）。账本必须记前者
    expect(att.facts!.exit).toMatchObject({ kind: "止损", px: 9, date: "2026-08-05" });
    expect(att.outcome!.actualPct).toBeCloseTo(-10, 6);
    // 不利偏移也就到止损为止，不是 -40%
    expect(att.outcome!.maePct).toBeCloseTo(-10, 6);
  });

  it("跳空低开已在止损线下时按开盘价离场 —— 拿不到止损价那个价", () => {
    seedDaily(db, "300502", [
      { date: "2026-08-03", c: 10 },
      { date: "2026-08-04", c: 10.1, o: 10.1, l: 9.9 },
      { date: "2026-08-05", c: 8.8, o: 8.5, h: 9.0, l: 8.4 }, // 开盘 8.5 已在止损 9 之下
      { date: "2026-08-10", c: 8.0 },
    ]);
    const att = settleOne(db, mkPred({ id: "st3", stopPx: 9, validUntil: "2026-08-10" }), {});
    expect(att.facts!.exit).toMatchObject({ kind: "止损", px: 8.5, date: "2026-08-05" });
    expect(att.outcome!.actualPct).toBeCloseTo(-15, 6);
    expect(att.outcome!.attribution).toContain("跳空低开");
  });

  it("止损当天破位之后才涨到的价不算进 MFE —— 那时已经离场了", () => {
    seedDaily(db, "300502", [
      { date: "2026-08-03", c: 10 },
      { date: "2026-08-04", c: 10.1, o: 10.1, l: 9.9 },
      // 开盘 9.8（未跳空）→ 盘中砸到 8.5 触发止损 → 尾盘拉到 12
      { date: "2026-08-05", c: 11.5, o: 9.8, h: 12, l: 8.5 },
      { date: "2026-08-10", c: 11 },
    ]);
    const att = settleOne(db, mkPred({ id: "st4", stopPx: 9, validUntil: "2026-08-10" }), {});
    expect(att.facts!.exit.px).toBe(9);
    // 当天最高 12 是止损打出来之后的事。算进去就是 +20%，纯属虚构
    expect(att.outcome!.mfePct).toBeCloseTo(1, 6);
  });

  it("看跌方向不适用止损口径：价格往下走正是清仓要的方向", () => {
    seedDaily(db, "300502", [
      { date: "2026-08-03", c: 10 },
      { date: "2026-08-04", c: 9.5, l: 9.4 },
      { date: "2026-08-05", c: 9.2, l: 8.8 },   // 破了 9，但这是「清仓」要的
      { date: "2026-08-10", c: 6.0 },
    ]);
    const p = mkPred({
      id: "sd1", action: "清仓", triggerPx: null, stopPx: 9, validUntil: "2026-08-10",
    });
    const att = settleOne(db, p, {});
    expect(att.facts!.stopBreached).toBe(false);
    // 无条件动作按基准收盘成交，跌到 6 对看跌判断是 +40% 的大对
    expect(att.outcome!.actualPct).toBeCloseTo(-40, 6);
    expect(att.outcome!.verdict).toBe("命中");
  });

  it("建仓当日不算持仓期：无条件入场按收盘成交，当日高低点发生在建仓之前", () => {
    seedDaily(db, "300502", [
      // 08-03 盘中砸到 8（已在止损 9 之下），尾盘拉回 10 —— 我们是按收盘 10 建的仓
      { date: "2026-08-03", c: 10, l: 8.0 },
      { date: "2026-08-04", c: 10.2, o: 10.2, h: 10.3, l: 10.1 },
      { date: "2026-08-05", c: 10.5 },
      { date: "2026-08-10", c: 11 },
    ]);
    // triggerPx 留空 → 无条件按基准日收盘 10 成交，成交日 = 基准日 08-03
    const att = settleOne(db, mkPred({
      id: "st5", triggerPx: null, stopPx: 9, validUntil: "2026-08-10",
    }), {});
    // 建仓前的 8.0 既不是"破止损"（那时还没仓位）也不是"持仓期回撤"
    expect(att.facts!.stopBreached).toBe(false);
    expect(att.facts!.exit).toMatchObject({ kind: "期满", px: 11 });
    expect(att.outcome!.actualPct).toBeCloseTo(10, 6);
    expect(att.outcome!.maePct).toBe(0);
  });

  it("存量行按止损口径重结，且是幂等的（第二遍不写）", () => {
    seedDaily(db, "300502", [
      { date: "2026-08-03", c: 10 },
      { date: "2026-08-04", c: 10.1, o: 10.1, l: 9.9 },
      { date: "2026-08-05", c: 9.2, o: 9.2, h: 9.5, l: 8.5 },
      { date: "2026-08-10", c: 6.0 },
    ]);
    recordPrediction(db, mkPred({ id: "rs1", stopPx: 9, validUntil: "2026-08-10" }));
    // 旧口径落的一行：硬扛到 6 的 -40%，还挂着一个旧错因
    db.prepare(
      `INSERT INTO outcome (pred_id, verdict, actual_pct, error_type, attribution, settled_at,
         triggered, entry_px, entry_date, mfe_pct, mae_pct)
       VALUES ('rs1','偏差',-40,'逆势扛','D5 硬扛到期末','2026-08-11T00:00:00.000Z',1,10,'2026-08-04',1,-40)`
    ).run();

    expect(resettleStoppedOut(db, "2026-08-11T01:00:00.000Z")).toBe(1);
    const row = db.prepare("SELECT * FROM outcome WHERE pred_id='rs1'").get() as any;
    expect(row.actual_pct).toBeCloseTo(-10, 6);
    expect(row.mae_pct).toBeCloseTo(-10, 6);
    // 事实变了，旧错因不能留着给新数当解释，清掉等 attributeSettled 重新归
    expect(row.error_type).toBeNull();
    expect(row.attribution).toContain("破止损");

    // 幂等：已经按止损口径结过 → 不重写，settled_at 也不跳
    expect(resettleStoppedOut(db, "2026-08-12T01:00:00.000Z")).toBe(0);
    const again = db.prepare("SELECT settled_at FROM outcome WHERE pred_id='rs1'").get() as any;
    expect(again.settled_at).toBe("2026-08-11T01:00:00.000Z");
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
