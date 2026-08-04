/**
 * 未来函数专项。
 *
 * 这一类 bug 的代价不对称：回测里它让曲线变漂亮，实盘里它让账户归零，
 * 而事后靠读代码几乎抓不出来（一句 ORDER BY date DESC LIMIT 1 就够了）。
 * 所以每一个"截至 asOf"的边界都在这里单独钉一颗钉子，而不是混在功能测试里。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createSqliteView } from "@/lib/pit/sqlite-view";
import {
  makeTempDb, insDaily, insQuote, insSecurity, insCalendar, insZt, insMacro, insMin,
  type TempDb,
} from "./helpers";

let t: TempDb;
beforeEach(() => { t = makeTempDb(); });
afterEach(() => { t.close(); });

describe("dailyBars 不返回 asOf 之后的日线", () => {
  beforeEach(() => {
    for (const [d, c] of [["2026-07-29", 10], ["2026-07-30", 11], ["2026-07-31", 12],
                          ["2026-08-03", 13], ["2026-08-04", 99]] as Array<[string, number]>) {
      insDaily(t.db, "600183", d, c);
    }
  });

  it("asOf 当日之后的那根 bar 拿不到 —— 本仓库最贵的一条断言", () => {
    const view = createSqliteView(t.db, "2026-08-03");
    const bars = view.dailyBars("600183", 10);
    expect(bars.map(b => b.date)).toEqual(
      ["2026-07-29", "2026-07-30", "2026-07-31", "2026-08-03"]);
    // 99 是未来那根的收盘价，出现即说明泄漏
    expect(bars.map(b => b.c)).not.toContain(99);
  });

  it("n 只截最近的，且升序（最后一根不晚于 asOf）", () => {
    const view = createSqliteView(t.db, "2026-08-03");
    const bars = view.dailyBars("600183", 2);
    expect(bars.map(b => b.date)).toEqual(["2026-07-31", "2026-08-03"]);
  });

  it("asOf 带盘中时间戳时，当日日线仍然算已发生（按日期比，不按时间比）", () => {
    // 盘中日线是滚动的当日快照，不是收盘价。要不要用它是因子层的判断，
    // 视图层的职责只有一条：不给它未来的日子。
    const view = createSqliteView(t.db, "2026-08-03 10:30:00");
    expect(view.dailyBars("600183", 1)[0].date).toBe("2026-08-03");
  });
});

describe("quote 不返回 asOf 之后的快照", () => {
  it("同一天更晚的快照拿不到", () => {
    insQuote(t.db, "600183", "2026-08-03 09:35:00", 10);
    insQuote(t.db, "600183", "2026-08-03 14:00:00", 20);
    const view = createSqliteView(t.db, "2026-08-03 10:00:00");
    expect(view.quote("600183")!.price).toBe(10);
  });

  it("库里 UTC 写的快照要折算成上海挂钟再比 —— 差 8 小时就是拿到了未来价", () => {
    // 数据层用 new Date().toISOString() 落 quote_snapshot（UTC 带 Z），
    // 而分钟线/板块榜落的是数据源原样的上海挂钟时间。字符串直接比会错 8 小时：
    // 14:00(上海) = 06:00Z 看起来比 asOf 的 10:00 "早"，于是盘中会读到下午的价。
    insQuote(t.db, "600183", "2026-08-03T01:35:00.000Z", 10);   // 上海 09:35
    insQuote(t.db, "600183", "2026-08-03T06:00:00.000Z", 20);   // 上海 14:00
    const view = createSqliteView(t.db, "2026-08-03 10:00:00");
    expect(view.quote("600183")!.price).toBe(10);
  });

  it("asOf 本身给 UTC 也认", () => {
    insQuote(t.db, "600183", "2026-08-03T01:35:00.000Z", 10);
    insQuote(t.db, "600183", "2026-08-03T06:00:00.000Z", 20);
    // 上海 10:00
    const view = createSqliteView(t.db, "2026-08-03T02:00:00.000Z");
    expect(view.quote("600183")!.price).toBe(10);
  });

  it("asOf 只给日期时取当日最后一条", () => {
    insQuote(t.db, "600183", "2026-08-03 09:35:00", 10);
    insQuote(t.db, "600183", "2026-08-03 14:55:00", 20);
    insQuote(t.db, "600183", "2026-08-04 09:35:00", 30);
    const view = createSqliteView(t.db, "2026-08-03");
    expect(view.quote("600183")!.price).toBe(20);
  });
});

describe("universe 幸存者偏差（spec §10.2）", () => {
  beforeEach(() => {
    insSecurity(t.db, "600183", { listDate: "2010-01-01" });
    // 恒立退：实测出现在 2025-07-15 龙虎榜，2025-08-01 退市
    insSecurity(t.db, "605100", { listDate: "2019-01-01", delistDate: "2025-08-01" });
    insSecurity(t.db, "301999", { listDate: "2026-09-01" });   // asOf 之后才上市
  });

  it("退市票在退市日之后不在标的池 —— 这条过滤就是 §10.2 的全部意义", () => {
    const view = createSqliteView(t.db, "2026-08-03");
    expect(view.universe().map(s => s.code)).not.toContain("605100");
  });

  it("退市日之前仍在池 —— 否则回测会连它上涨的那几年一起抹掉", () => {
    const view = createSqliteView(t.db, "2025-07-15");
    expect(view.universe().map(s => s.code)).toContain("605100");
  });

  it("退市当日不在池（delist_date > asOf 才算在市）", () => {
    const view = createSqliteView(t.db, "2025-08-01");
    expect(view.universe().map(s => s.code)).not.toContain("605100");
  });

  it("尚未上市的票不在池 —— 拿当前清单回测就是靠这条把未来 IPO 挡掉", () => {
    const view = createSqliteView(t.db, "2026-08-03");
    expect(view.universe().map(s => s.code)).not.toContain("301999");
  });
});

describe("其它截面的 asOf 边界", () => {
  it("请求 asOf 之后的截面日期直接抛错，不返回空数组", () => {
    // spec §4.2：越界访问抛异常。返回空数组会被因子当成"当天没涨停"，
    // 而不是"你问错日期了"，回测里就是一整段静默失真。
    insZt(t.db, "2026-08-04", "600183");
    const view = createSqliteView(t.db, "2026-08-03");
    expect(() => view.ztPool("2026-08-04")).toThrow(/asOf/);
    expect(() => view.lhb("2026-08-04")).toThrow(/asOf/);
    expect(() => view.dtPool("2026-08-04")).toThrow(/asOf/);
    expect(() => view.sectorRank("2026-08-04")).toThrow(/asOf/);
    expect(() => view.lhbSeats("2026-08-04")).toThrow(/asOf/);
  });

  it("tradingDays 的 to 超过 asOf 时截断，不抛错", () => {
    insCalendar(t.db, ["2026-07-31", "2026-08-03", "2026-08-04", "2026-08-05"]);
    const view = createSqliteView(t.db, "2026-08-03");
    expect(view.tradingDays("2026-07-01", "2026-12-31")).toEqual(["2026-07-31", "2026-08-03"]);
  });

  it("prevTradingDay 不会跨过 asOf", () => {
    insCalendar(t.db, ["2026-07-31", "2026-08-03", "2026-08-04"]);
    const view = createSqliteView(t.db, "2026-08-03");
    expect(view.prevTradingDay("2026-08-05")).toBe("2026-08-03");
  });

  it("macro 不返回 asOf 之后的读数", () => {
    insMacro(t.db, "2026-08-03 09:00:00", "A50", 13000, -1.2);
    insMacro(t.db, "2026-08-03 14:00:00", "A50", 13100, 0.5);
    const view = createSqliteView(t.db, "2026-08-03 10:00:00");
    const rows = view.macro("A50", 5);
    expect(rows).toHaveLength(1);
    expect(rows[0].pct).toBe(-1.2);
  });

  it("minuteBars 不返回 asOf 之后的分钟线", () => {
    insMin(t.db, "600183", "2026-08-03 09:35:00", "m5", 10);
    insMin(t.db, "600183", "2026-08-03 13:05:00", "m5", 20);
    const view = createSqliteView(t.db, "2026-08-03 10:00:00");
    const bars = view.minuteBars("600183", 5, 10);
    expect(bars.map(b => b.c)).toEqual([10]);
  });

  it("截面访问器接受带时间的日期串（因子层的 evalDate 会原样传 asOf）", () => {
    // evalDate 默认把 view.asOf 当日期用，那可能是 "2026-08-03 10:00:00"。
    // 不归一化的话 `WHERE date = ?` 会静默查不到行 —— 又一个不报错的失真。
    insZt(t.db, "2026-08-03", "600183");
    const view = createSqliteView(t.db, "2026-08-03 10:30:00");
    expect(view.ztPool("2026-08-03 10:30:00").map(z => z.code)).toEqual(["600183"]);
  });

  it("截面访问器的日期格式不合法时抛错", () => {
    const view = createSqliteView(t.db, "2026-08-03");
    expect(() => view.ztPool("昨天")).toThrow(/格式/);
  });

  it("hasGap 也不许问未来", () => {
    const view = createSqliteView(t.db, "2026-08-03");
    expect(() => view.hasGap("2026-08-04")).toThrow(/asOf/);
  });

  it("security 的 ST 区间不泄漏 asOf 之后才戴帽的那一段", () => {
    // 2022 年的回测不该知道这只票 2027 年会被 ST。
    insSecurity(t.db, "600000", {
      stJson: JSON.stringify([
        { from: "2021-04-30", to: "2022-06-01" },
        { from: "2027-04-30", to: null },
      ]),
    });
    const view = createSqliteView(t.db, "2022-08-03");
    expect(view.security("600000")!.isStHistory).toEqual([
      { from: "2021-04-30", to: "2022-06-01" },
    ]);
  });
});
