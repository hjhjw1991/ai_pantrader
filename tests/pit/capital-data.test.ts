/**
 * 两融 / 互联互通 / 增减持的 PIT 时点约束。
 *
 * 最要紧的一条：两融与互联互通**严格早于评估日**。T 日的两融数据 T+1 开盘前才发布，
 * 而回测时它确实已经躺在库里 —— 这是最容易被悄悄用上的一类未来数据。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createSqliteView } from "@/lib/pit/sqlite-view";
import { makeTempDb, type TempDb } from "./helpers";

let t: TempDb;
beforeEach(() => { t = makeTempDb(); });
afterEach(() => { t.close(); });

const ASOF = "2026-09-23 15:05:00";
const mm = (d: string, rzye: number) => t.db.prepare(
  `INSERT INTO margin_market (date, rzye, rqye, rzrqye, rzmre, rzche, rzjme, rzyezb, ltsz)
   VALUES (?, ?, 0, 0, 0, 0, 1, 0.026, 1)`).run(d, rzye);
const ms = (d: string, code: string, rzye: number) => t.db.prepare(
  `INSERT INTO margin_stock (date, code, rzye, rzmre, rzche, rzjme, rqye, rqyl, rzrqye, rzyezb)
   VALUES (?, ?, ?, 0, 0, 0, 0, 0, 0, 0.05)`).run(d, code, rzye);
const md = (d: string, type: string, amt: number, net: number | null = null) => t.db.prepare(
  `INSERT INTO mutual_deal (date, mutual_type, deal_amt, net_amt) VALUES (?, ?, ?, ?)`).run(d, type, amt, net);
const top = (d: string, code: string) => t.db.prepare(
  `INSERT INTO mutual_top10 (date, mutual_type, code, rank, deal_amt, mutual_ratio) VALUES (?, '001', ?, 1, 1e9, 0.1)`).run(d, code);
const hc = (code: string, notice: string, dir: string, ratio: number | null) => t.db.prepare(
  `INSERT INTO holder_change (code, holder, direction, start_date, end_date, notice_date,
     change_shares, change_free_ratio, after_hold_ratio, market)
   VALUES (?, ?, ?, '2026-08-01', ?, ?, -1e6, ?, 0.05, '二级市场')`).run(code, `股东${notice}`, dir, notice, notice, ratio);

describe("marginMarket", () => {
  it("严格早于评估日：评估日当天那条哪怕在库里也看不见（T+1 才发布）", () => {
    mm("2026-09-21", 100); mm("2026-09-22", 101); mm("2026-09-23", 102);
    const r = createSqliteView(t.db, ASOF).marginMarket(5);
    expect(r.map(x => x.date)).toEqual(["2026-09-21", "2026-09-22"]);
  });

  it("取最近 n 条、按日期升序", () => {
    for (const d of ["2026-09-15", "2026-09-16", "2026-09-17", "2026-09-18"]) mm(d, 100);
    expect(createSqliteView(t.db, ASOF).marginMarket(2).map(x => x.date)).toEqual(["2026-09-17", "2026-09-18"]);
  });

  it("带回余额与占流通比", () => {
    mm("2026-09-22", 2.6e12);
    expect(createSqliteView(t.db, ASOF).marginMarket(1)[0]).toMatchObject({ rzye: 2.6e12, rzyezb: 0.026 });
  });
});

describe("marginStock", () => {
  it("同样严格早于评估日，且只给这一只", () => {
    ms("2026-09-22", "600000", 1e9); ms("2026-09-23", "600000", 2e9); ms("2026-09-22", "000001", 3e9);
    const r = createSqliteView(t.db, ASOF).marginStock("600000", 5);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ date: "2026-09-22", rzye: 1e9 });
  });
});

describe("mutualDeal", () => {
  it("最近 n 个**有数据的日子**（港股休市时没有行），严格早于评估日", () => {
    md("2026-09-18", "005", 1); md("2026-09-18", "006", 2, 5);
    md("2026-09-22", "005", 3); md("2026-09-23", "005", 4);
    const r = createSqliteView(t.db, ASOF).mutualDeal(1);
    expect(r).toEqual([{ date: "2026-09-22", mutualType: "005", dealAmt: 3, netAmt: null }]);
    expect(createSqliteView(t.db, ASOF).mutualDeal(2).map(x => x.date)).toEqual(["2026-09-18", "2026-09-18", "2026-09-22"]);
  });
});

describe("mutualTop10", () => {
  it("(评估日−N, 评估日) 内的上榜记录，不含评估日", () => {
    top("2026-09-10", "600000"); top("2026-09-18", "600000"); top("2026-09-23", "600000");
    expect(createSqliteView(t.db, ASOF).mutualTop10("600000", 10).map(x => x.date)).toEqual(["2026-09-18"]);
  });
});

describe("holderChanges", () => {
  it("公告日 ≤ 评估日才算：公告了市场才知道", () => {
    hc("600000", "2026-09-23", "减持", -0.01);
    hc("600000", "2026-09-24", "减持", -0.02);
    expect(createSqliteView(t.db, ASOF).holderChanges("600000", 60).map(x => x.noticeDate)).toEqual(["2026-09-23"]);
  });

  it("窗口之外的旧公告不算", () => {
    hc("600000", "2026-06-01", "减持", -0.01);
    expect(createSqliteView(t.db, ASOF).holderChanges("600000", 60)).toEqual([]);
  });

  it("比例带符号原样返回，null 保持 null", () => {
    hc("600000", "2026-09-01", "增持", 0.003);
    hc("600000", "2026-09-02", "减持", null);
    const r = createSqliteView(t.db, ASOF).holderChanges("600000", 60);
    expect(r.map(x => [x.direction, x.changeFreeRatio])).toEqual([["增持", 0.003], ["减持", null]]);
  });
});
