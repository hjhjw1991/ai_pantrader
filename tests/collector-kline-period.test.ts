import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb } from "@/lib/db";
import { runMigrations } from "@/lib/db/migrate";
import { buildPeriodBars, isoWeekKey } from "@/lib/data/collectors/kline-period";

let dir: string, db: any;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "pt-per-"));
  db = openDb(path.join(dir, "t.db"));
  runMigrations(db);
});
afterEach(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });

const ins = (
  code: string, date: string,
  v: { o: number; h: number; l: number; c: number; vol?: number; adj?: number }
) => db.prepare(
  `INSERT OR REPLACE INTO kline_daily (code, date, o, h, l, c, vol, amount, adj_factor)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
).run(code, date, v.o, v.h, v.l, v.c, v.vol ?? 100, (v.vol ?? 100) * v.c, v.adj ?? 1);

const rows = (code: string, period: string) =>
  db.prepare("SELECT * FROM kline_period WHERE code=? AND period=? ORDER BY date").all(code, period);

describe("isoWeekKey", () => {
  it("同一周的交易日落进同一个键", () => {
    // 2026-07-13 周一 … 2026-07-17 周五
    const ks = ["2026-07-13", "2026-07-14", "2026-07-17"].map(isoWeekKey);
    expect(new Set(ks).size).toBe(1);
  });

  it("跨周分开", () => {
    expect(isoWeekKey("2026-07-17")).not.toBe(isoWeekKey("2026-07-20"));
  });

  it("跨年周仍算同一周 —— 12 月底与 1 月初可能属于同一个 ISO 周", () => {
    // 2026-12-28 周一 … 2027-01-01 周五，同属 2026-W53
    expect(isoWeekKey("2026-12-28")).toBe(isoWeekKey("2027-01-01"));
  });
});

describe("buildPeriodBars 周线", () => {
  it("开=首日开，高=区间最高，低=区间最低，收=末日收，量=求和", () => {
    ins("600000", "2026-07-13", { o: 10, h: 11, l: 9.5, c: 10.5, vol: 100 });
    ins("600000", "2026-07-14", { o: 10.5, h: 12, l: 10, c: 11.8, vol: 200 });
    ins("600000", "2026-07-17", { o: 11.8, h: 11.9, l: 9.0, c: 9.2, vol: 300 });
    ins("600000", "2026-07-20", { o: 9.2, h: 9.5, l: 9.1, c: 9.4, vol: 50 }); // 下一周，促使上一周完整

    buildPeriodBars(db, ["600000"]);
    const w = rows("600000", "W");
    expect(w.length).toBe(1);                       // 只有走完的那一周
    expect(w[0].date).toBe("2026-07-17");           // 键是该周最后一个交易日
    expect(w[0].o).toBeCloseTo(10, 6);
    expect(w[0].h).toBeCloseTo(12, 6);
    expect(w[0].l).toBeCloseTo(9.0, 6);
    expect(w[0].c).toBeCloseTo(9.2, 6);
    expect(w[0].vol).toBeCloseTo(600, 6);
  });

  it("**不写未走完的那一周** —— 写了会被明天的数据覆盖，回测重放到周二却看到周五的收盘", () => {
    ins("600000", "2026-07-20", { o: 9, h: 9.5, l: 8.9, c: 9.4 });
    ins("600000", "2026-07-21", { o: 9.4, h: 9.6, l: 9.2, c: 9.5 });
    buildPeriodBars(db, ["600000"]);
    expect(rows("600000", "W").length).toBe(0);
  });

  it("用**后复权**价聚合 —— 周线是给技术指标用的，除权缺口会造出不存在的金叉死叉", () => {
    ins("600000", "2026-07-13", { o: 10, h: 10, l: 10, c: 10, adj: 2 });
    ins("600000", "2026-07-20", { o: 9, h: 9, l: 9, c: 9, adj: 2 });
    buildPeriodBars(db, ["600000"]);
    expect(rows("600000", "W")[0].c).toBeCloseTo(20, 6);
  });

  it("停牌周少几根照样聚合，不补也不跳", () => {
    ins("600000", "2026-07-15", { o: 10, h: 10.2, l: 9.9, c: 10.1 });  // 该周只有一根
    ins("600000", "2026-07-20", { o: 10, h: 10, l: 10, c: 10 });
    buildPeriodBars(db, ["600000"]);
    const w = rows("600000", "W");
    expect(w.length).toBe(1);
    expect(w[0].date).toBe("2026-07-15");
    expect(w[0].c).toBeCloseTo(10.1, 6);
  });
});

describe("buildPeriodBars 月线", () => {
  it("按自然月聚合，只写走完的月", () => {
    ins("600000", "2026-06-29", { o: 8, h: 8.5, l: 7.9, c: 8.4 });
    ins("600000", "2026-06-30", { o: 8.4, h: 8.8, l: 8.3, c: 8.7 });
    ins("600000", "2026-07-01", { o: 8.7, h: 9, l: 8.6, c: 8.9 });
    buildPeriodBars(db, ["600000"]);
    const m = rows("600000", "M");
    expect(m.length).toBe(1);
    expect(m[0].date).toBe("2026-06-30");
    expect(m[0].o).toBeCloseTo(8, 6);
    expect(m[0].c).toBeCloseTo(8.7, 6);
  });
});

describe("重跑与隔离", () => {
  it("幂等", () => {
    ins("600000", "2026-07-13", { o: 10, h: 10, l: 10, c: 10 });
    ins("600000", "2026-07-20", { o: 9, h: 9, l: 9, c: 9 });
    buildPeriodBars(db, ["600000"]);
    const a = rows("600000", "W").length;
    buildPeriodBars(db, ["600000"]);
    expect(rows("600000", "W").length).toBe(a);
  });

  it("只处理指定的票", () => {
    ins("600000", "2026-07-13", { o: 10, h: 10, l: 10, c: 10 });
    ins("600000", "2026-07-20", { o: 9, h: 9, l: 9, c: 9 });
    ins("000001", "2026-07-13", { o: 10, h: 10, l: 10, c: 10 });
    ins("000001", "2026-07-20", { o: 9, h: 9, l: 9, c: 9 });
    buildPeriodBars(db, ["600000"]);
    expect(rows("600000", "W").length).toBe(1);
    expect(rows("000001", "W").length).toBe(0);
  });

  it("没有日线的票不报错", () => {
    expect(() => buildPeriodBars(db, ["999999"])).not.toThrow();
  });
});
