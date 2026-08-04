/**
 * 契约里是 number（不可空）的列为 NULL 时，视图必须**不返回这一行**，绝不补 0。
 *
 * 为什么单独一个文件：这是与未来函数并列的第二类假利润来源，而且更隐蔽。
 * 涨停成交概率 p = 1/(1 + 封单额/成交额 / sealHalfRatio)：
 *   - 没有这一行  → 回测判 p=0，买不进（保守，正确）
 *   - sealAmt = 0 → 回测判 p=1，买到了（一只根本买不进的涨停被算成了利润）
 * zt_pool 不可回补，2026-08-03 之前的涨停一律没有封单数据，
 * 所以"缺数据补 0"会把整段历史的涨停都变成可买 —— 回测曲线漂亮，实盘一手也买不到。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createSqliteView } from "@/lib/pit/sqlite-view";
import { makeTempDb, insQuote, type TempDb } from "./helpers";

let t: TempDb;
beforeEach(() => { t = makeTempDb(); });
afterEach(() => { t.close(); });

const view = () => createSqliteView(t.db, "2026-08-03");

describe("涨停池 / 跌停池", () => {
  it("seal_amt 为 NULL 的涨停行整行不返回", () => {
    t.db.prepare(
      `INSERT INTO zt_pool (date, code, name, lbc, seal_amt, open_times)
       VALUES ('2026-08-03', '600183', '生益科技', 3, NULL, 0)`
    ).run();
    const rows = view().ztPool("2026-08-03");
    expect(rows).toEqual([]);
    // 不是"返回了一行 sealAmt=0"
    expect(rows.some(r => r.sealAmt === 0)).toBe(false);
  });

  it("lbc / open_times 为 NULL 的涨停行也整行不返回（半行快照说明写错了）", () => {
    t.db.prepare(
      `INSERT INTO zt_pool (date, code, name, lbc, seal_amt, open_times)
       VALUES ('2026-08-03', '600183', 'x', NULL, 1e8, 0)`
    ).run();
    t.db.prepare(
      `INSERT INTO zt_pool (date, code, name, lbc, seal_amt, open_times)
       VALUES ('2026-08-03', '600000', 'y', 1, 1e8, NULL)`
    ).run();
    expect(view().ztPool("2026-08-03")).toEqual([]);
  });

  it("字段齐全的行照常返回", () => {
    t.db.prepare(
      `INSERT INTO zt_pool (date, code, name, lbc, seal_amt, open_times)
       VALUES ('2026-08-03', '600183', 'x', 3, 2.5e8, 1)`
    ).run();
    expect(view().ztPool("2026-08-03")).toHaveLength(1);
  });

  it("跌停池 seal_amt 为 NULL 时整行不返回 —— 0 封单会让回测以为跌停也能卖", () => {
    t.db.prepare(`INSERT INTO dt_pool (date, code, name, seal_amt)
                  VALUES ('2026-08-03', '002131', 'x', NULL)`).run();
    expect(view().dtPool("2026-08-03")).toEqual([]);
  });
});

describe("日线 / 分钟线", () => {
  it("o/h/l/c 任一为 NULL 的日线不返回 —— 0 价等于 -100%", () => {
    t.db.prepare(`INSERT INTO kline_daily (code, date, o, h, l, c, vol)
                  VALUES ('600183', '2026-08-03', 10, 11, NULL, 10.5, 1e6)`).run();
    expect(view().dailyBars("600183", 5)).toEqual([]);
  });

  it("vol 为 NULL 的日线不返回", () => {
    t.db.prepare(`INSERT INTO kline_daily (code, date, o, h, l, c, vol)
                  VALUES ('600183', '2026-08-03', 10, 11, 9, 10.5, NULL)`).run();
    expect(view().dailyBars("600183", 5)).toEqual([]);
  });

  it("amount 为 NULL 仍返回（新浪日线不给成交额，全表 NULL；排掉它等于一根都没有）", () => {
    // 这是唯一的例外，它的唯一消费者（回测封板模型）对 amount<=0 做了保守处理。
    // 成交额有了数据源之后这条应当收紧。
    t.db.prepare(`INSERT INTO kline_daily (code, date, o, h, l, c, vol, amount)
                  VALUES ('600183', '2026-08-03', 10, 11, 9, 10.5, 1e6, NULL)`).run();
    const bars = view().dailyBars("600183", 5);
    expect(bars).toHaveLength(1);
    expect(bars[0].amount).toBe(0);
  });

  it("分钟线缺价量的行不返回", () => {
    t.db.prepare(`INSERT INTO kline_min (code, ts, period, o, h, l, c, vol)
                  VALUES ('600183', '2026-08-03 09:35:00', 'm5', 10, 10, 10, NULL, 100)`).run();
    expect(view().minuteBars("600183", 5, 10)).toEqual([]);
  });
});

describe("快照 / 龙虎榜 / 外围", () => {
  it("换手或振幅为 NULL 的快照不返回 —— 0 换手会让换手上限那道筛假通过", () => {
    t.db.prepare(
      `INSERT INTO quote_snapshot (ts, code, price, pct, turnover, amplitude)
       VALUES ('2026-08-03 09:35:00', '600183', 10, 1, NULL, 3)`
    ).run();
    expect(view().quote("600183")).toBeNull();
  });

  it("有更早一条完整快照时退回用它，而不是返回缺字段的那条", () => {
    insQuote(t.db, "600183", "2026-08-03 09:35:00", 10, { turnover: 6 });
    t.db.prepare(
      `INSERT INTO quote_snapshot (ts, code, price, pct, turnover, amplitude)
       VALUES ('2026-08-03 10:35:00', '600183', 12, 1, NULL, 3)`
    ).run();
    expect(view().quote("600183")!.price).toBe(10);
  });

  it("龙虎榜三个金额列缺任一则整行不返回", () => {
    t.db.prepare(
      `INSERT INTO lhb (date, code, change_type, name, net_amt, buy_amt, sell_amt)
       VALUES ('2026-08-03', '002131', '1', 'x', NULL, 5e7, 0)`
    ).run();
    expect(view().lhb("2026-08-03")).toEqual([]);
  });

  it("龙虎榜可空字段（d1~d30 / 换手率 / 成交占比）保持 null，不补 0", () => {
    t.db.prepare(
      `INSERT INTO lhb (date, code, change_type, name, net_amt, buy_amt, sell_amt)
       VALUES ('2026-08-03', '002131', '1', 'x', 5e7, 5e7, 0)`
    ).run();
    const r = view().lhb("2026-08-03")[0];
    expect(r.d1Chg).toBeNull();
    expect(r.turnoverRate).toBeNull();
    expect(r.dealAmountRatio).toBeNull();
    expect(r.closePrice).toBeNull();
    expect(r.changeRate).toBeNull();
  });

  it("席位金额缺失的行不返回，但 rise_prob_3d 这类可空字段保持 null", () => {
    t.db.prepare(
      `INSERT INTO lhb_seat (date, code, change_type, side, dept_name, buy_amt, sell_amt, net_amt)
       VALUES ('2026-08-03', '002131', '1', 'buy', '机构专用', NULL, 0, 2e7)`
    ).run();
    t.db.prepare(
      `INSERT INTO lhb_seat (date, code, change_type, side, dept_name, buy_amt, sell_amt, net_amt)
       VALUES ('2026-08-03', '002131', '1', 'buy', '华鑫上海', 2e7, 0, 2e7)`
    ).run();
    const rows = view().lhbSeats("2026-08-03");
    expect(rows.map(r => r.deptName)).toEqual(["华鑫上海"]);
    expect(rows[0].riseProb3d).toBeNull();
  });

  it("外围读数缺 price/pct 的行不返回", () => {
    t.db.prepare(`INSERT INTO macro (ts, symbol, price, pct)
                  VALUES ('2026-08-03 09:00:00', 'A50', 13000, NULL)`).run();
    expect(view().macro("A50", 5)).toEqual([]);
  });

  it("板块榜 pct 为 NULL 的行不返回", () => {
    t.db.prepare(`INSERT INTO sector_rank (date, ts, sector, pct)
                  VALUES ('2026-08-03', '2026-08-03 15:00:00', '半导体', NULL)`).run();
    expect(view().sectorRank("2026-08-03")).toEqual([]);
  });
});
