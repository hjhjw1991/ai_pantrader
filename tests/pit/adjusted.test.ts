/**
 * 复权序列与多周期序列。
 *
 * 用真库跑（与 sqlite-view.test.ts 同理）：这两个方法的价值全在 SQL 有没有被 asOf 夹住、
 * 有没有正确乘上因子，用替身测等于测替身。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createSqliteView } from "@/lib/pit/sqlite-view";
import { makeTempDb, insDaily, type TempDb } from "./helpers";

let t: TempDb;
beforeEach(() => { t = makeTempDb(); });
afterEach(() => { t.close(); });

const insPeriod = (code: string, period: string, date: string, c: number) =>
  t.db.prepare(
    `INSERT OR REPLACE INTO kline_period (code, period, date, o, h, l, c, vol, amount)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1, 1)`
  ).run(code, period, date, c, c, c, c);

describe("adjBars", () => {
  it("OHLC 全部乘上当日因子，因子本身保留以便追溯", () => {
    insDaily(t.db, "600000", "2026-07-15", 9.31, { o: 9.2, h: 9.4, l: 9.1, adj: 1 });
    insDaily(t.db, "600000", "2026-07-16", 8.85, { o: 8.9, h: 9.0, l: 8.8, adj: 1.0472 });
    const v = createSqliteView(t.db, "2026-07-16 15:05:00");

    const bars = v.adjBars("600000", 5);
    expect(bars.length).toBe(2);
    expect(bars[0].c).toBeCloseTo(9.31, 6);
    expect(bars[1].c).toBeCloseTo(8.85 * 1.0472, 6);
    expect(bars[1].o).toBeCloseTo(8.9 * 1.0472, 6);
    expect(bars[1].h).toBeCloseTo(9.0 * 1.0472, 6);
    expect(bars[1].l).toBeCloseTo(8.8 * 1.0472, 6);
    expect(bars[1].adjFactor).toBeCloseTo(1.0472, 6);
  });

  it("成交量不乘因子 —— 复权调的是价格，量是量", () => {
    insDaily(t.db, "600000", "2026-07-16", 8.85, { vol: 12345, adj: 2 });
    const v = createSqliteView(t.db, "2026-07-16 15:05:00");
    expect(v.adjBars("600000", 5)[0].vol).toBe(12345);
  });

  it("与 dailyBars 一样被 asOf 夹住，不会看到未来", () => {
    insDaily(t.db, "600000", "2026-07-16", 8.85, { adj: 1 });
    insDaily(t.db, "600000", "2026-07-17", 8.87, { adj: 1 });
    const v = createSqliteView(t.db, "2026-07-16 15:05:00");
    expect(v.adjBars("600000", 10).map(b => b.date)).toEqual(["2026-07-16"]);
  });

  it("dailyBars 仍然返回**原始价** —— 触发价与涨跌停判定靠它，绝不能被复权污染", () => {
    insDaily(t.db, "600000", "2026-07-16", 8.85, { adj: 1.0472 });
    const v = createSqliteView(t.db, "2026-07-16 15:05:00");
    expect(v.dailyBars("600000", 5)[0].c).toBeCloseTo(8.85, 6);
  });
});

describe("periodBars", () => {
  it("取周线，按 asOf 夹住并升序返回", () => {
    insPeriod("600000", "W", "2026-07-03", 10);
    insPeriod("600000", "W", "2026-07-10", 11);
    insPeriod("600000", "W", "2026-07-17", 12);
    const v = createSqliteView(t.db, "2026-07-10 15:05:00");
    expect(v.periodBars("600000", "W", 10).map(b => b.date)).toEqual(["2026-07-03", "2026-07-10"]);
  });

  it("月线与周线互不串台", () => {
    insPeriod("600000", "W", "2026-07-03", 10);
    insPeriod("600000", "M", "2026-07-31", 99);
    const v = createSqliteView(t.db, "2026-08-01 15:05:00");
    expect(v.periodBars("600000", "M", 10).map(b => b.c)).toEqual([99]);
    expect(v.periodBars("600000", "W", 10).map(b => b.c)).toEqual([10]);
  });

  it("只取最近 n 根", () => {
    for (const [d, c] of [["2026-06-05", 1], ["2026-06-12", 2], ["2026-06-19", 3]] as const) {
      insPeriod("600000", "W", d as string, c as number);
    }
    const v = createSqliteView(t.db, "2026-06-30 15:05:00");
    expect(v.periodBars("600000", "W", 2).map(b => b.c)).toEqual([2, 3]);
  });

  it("没有数据返回空数组，不抛错 —— 新股与停牌票天然没有周线", () => {
    const v = createSqliteView(t.db, "2026-07-16 15:05:00");
    expect(v.periodBars("999999", "W", 5)).toEqual([]);
  });
});
