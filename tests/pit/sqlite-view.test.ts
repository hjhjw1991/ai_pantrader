/**
 * PIT 视图的功能面：每个方法把库里的行正确翻译成契约类型。
 * 未来函数的边界另见 no-lookahead.test.ts。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createSqliteView, universeQuality, gapKinds } from "@/lib/pit/sqlite-view";
import {
  makeTempDb, insDaily, insMin, insQuote, insSecurity, insCalendar,
  insZt, insDt, insSectorRank, insLhb, insSeat, insMacro, insGap,
  type TempDb,
} from "./helpers";

let t: TempDb;
beforeEach(() => { t = makeTempDb(); });
afterEach(() => { t.close(); });

describe("asOf", () => {
  it("原样暴露传入的 asOf（因子层的 evalDate 拿它做字符串比较）", () => {
    expect(createSqliteView(t.db, "2026-08-03 10:00:00").asOf).toBe("2026-08-03 10:00:00");
  });

  it("asOf 不是合法时间戳时抛错，不静默当成 1970", () => {
    expect(() => createSqliteView(t.db, "昨天")).toThrow(/asOf/);
    expect(() => createSqliteView(t.db, "")).toThrow(/asOf/);
  });
});

describe("dailyBars", () => {
  it("字段与复权因子完整", () => {
    insDaily(t.db, "600183", "2026-08-03", 13, { o: 12, h: 14, l: 11.5, vol: 2e6, amount: 2.6e7, adj: 1.23 });
    const b = createSqliteView(t.db, "2026-08-03").dailyBars("600183", 1)[0];
    expect(b).toEqual({
      code: "600183", date: "2026-08-03",
      o: 12, h: 14, l: 11.5, c: 13, vol: 2e6, amount: 2.6e7, adjFactor: 1.23,
    });
  });

  it("adj_factor 为 NULL 时按 1 —— spec R1 说了 2022-05~2023-12 段没有复权参照", () => {
    t.db.prepare(
      `INSERT INTO kline_daily (code, date, o, h, l, c, vol, amount, adj_factor)
       VALUES ('600183', '2026-08-03', 1, 1, 1, 1, 1, 1, NULL)`
    ).run();
    expect(createSqliteView(t.db, "2026-08-03").dailyBars("600183", 1)[0].adjFactor).toBe(1);
  });

  it("无数据返回空数组", () => {
    expect(createSqliteView(t.db, "2026-08-03").dailyBars("000001", 5)).toEqual([]);
  });

  it("n <= 0 返回空数组", () => {
    insDaily(t.db, "600183", "2026-08-03", 13);
    expect(createSqliteView(t.db, "2026-08-03").dailyBars("600183", 0)).toEqual([]);
  });
});

describe("minuteBars", () => {
  it("period 数字与库里的 'm5' 写法对得上，返回升序", () => {
    insMin(t.db, "600183", "2026-08-03 09:35:00", "m5", 10);
    insMin(t.db, "600183", "2026-08-03 09:40:00", "m5", 11);
    insMin(t.db, "600183", "2026-08-03 09:40:00", "m15", 99);
    const bars = createSqliteView(t.db, "2026-08-03 15:00:00").minuteBars("600183", 5, 10);
    expect(bars.map(b => b.c)).toEqual([10, 11]);
    expect(bars[0].period).toBe(5);
  });
});

describe("quote", () => {
  it("字段完整", () => {
    insQuote(t.db, "600183", "2026-08-03 14:55:00", 13.2, { pct: 3.5, turnover: 8.1, amplitude: 6.2 });
    expect(createSqliteView(t.db, "2026-08-03").quote("600183")).toEqual({
      code: "600183", ts: "2026-08-03 14:55:00",
      price: 13.2, pct: 3.5, turnover: 8.1, amplitude: 6.2,
    });
  });

  it("没有快照返回 null（停牌 / 未上市），不是 0 价", () => {
    expect(createSqliteView(t.db, "2026-08-03").quote("600183")).toBeNull();
  });

  it("快照里 price 为 0 或 NULL 时返回 null —— 0 价会被当成跌停或崩盘", () => {
    insQuote(t.db, "600183", "2026-08-03 09:35:00", 0);
    insQuote(t.db, "600000", "2026-08-03 09:35:00", null as unknown as number);
    const view = createSqliteView(t.db, "2026-08-03");
    expect(view.quote("600183")).toBeNull();
    expect(view.quote("600000")).toBeNull();
  });

  it("0 价那条之前若有正常快照，退回用正常那条", () => {
    // 停牌当日 gtimg 会回 0 价。直接判 null 会让因子以为这只票从没有过价格。
    insQuote(t.db, "600183", "2026-08-03 09:35:00", 10);
    insQuote(t.db, "600183", "2026-08-03 10:35:00", 0);
    expect(createSqliteView(t.db, "2026-08-03").quote("600183")!.price).toBe(10);
  });
});

describe("涨停池 / 跌停池 / 板块榜", () => {
  it("ztPool 字段完整", () => {
    insZt(t.db, "2026-08-03", "600183", { lbc: 3, sealAmt: 2.5e8, openTimes: 1, sector: "半导体" });
    expect(createSqliteView(t.db, "2026-08-03").ztPool("2026-08-03")).toEqual([{
      date: "2026-08-03", code: "600183", lbc: 3, sealAmt: 2.5e8, openTimes: 1,
      firstSealTs: null, lastSealTs: null, sector: "半导体",
    }]);
  });

  it("dtPool / sectorRank 字段完整", () => {
    insDt(t.db, "2026-08-03", "002131", 3e7);
    insSectorRank(t.db, "2026-08-03", "半导体", 4.2, { leaderCode: "600183" });
    const view = createSqliteView(t.db, "2026-08-03");
    expect(view.dtPool("2026-08-03")).toEqual([{ date: "2026-08-03", code: "002131", sealAmt: 3e7 }]);
    expect(view.sectorRank("2026-08-03")).toEqual([{
      date: "2026-08-03", ts: "2026-08-03 15:00:00", sector: "半导体", pct: 4.2, leaderCode: "600183",
    }]);
  });

  it("空日期返回空数组", () => {
    const view = createSqliteView(t.db, "2026-08-03");
    expect(view.ztPool("2026-08-03")).toEqual([]);
    expect(view.dtPool("2026-08-03")).toEqual([]);
    expect(view.sectorRank("2026-08-03")).toEqual([]);
  });
});

describe("龙虎榜", () => {
  it("同票同日多个上榜原因全部返回，不按 code 去重", () => {
    // 实测利欧股份(002131) 2026-08-03 同日三条，净买额各不相同。
    // 按 code 去重会丢 48% 的行（migration 003 的原因）。
    insLhb(t.db, "2026-08-03", "002131", "1", 5e7, { explanation: "日换手率达到20%的前5只证券" });
    insLhb(t.db, "2026-08-03", "002131", "2", 3e7, { explanation: "日涨幅偏离值达到7%的前5只证券" });
    insLhb(t.db, "2026-08-03", "002131", "3", -1e7, { explanation: "连续三个交易日内，涨幅偏离值累计达到20%的证券" });
    const rows = createSqliteView(t.db, "2026-08-03").lhb("2026-08-03");
    expect(rows).toHaveLength(3);
    expect(rows.map(r => r.changeType).sort()).toEqual(["1", "2", "3"]);
    expect(new Set(rows.map(r => r.netAmt)).size).toBe(3);
  });

  it("explanation 与 explain_stat 分开映射 —— 混了会按统计口径 blurb 聚类", () => {
    insLhb(t.db, "2026-08-03", "002131", "1", 5e7, {
      explanation: "日换手率达到20%的前5只证券",
      explainStat: "3家机构买入，成功率38.45%",
    });
    const r = createSqliteView(t.db, "2026-08-03").lhb("2026-08-03")[0];
    expect(r.explanation).toBe("日换手率达到20%的前5只证券");
    expect(r.explainStat).toBe("3家机构买入，成功率38.45%");
  });

  it("后续涨跌幅未回填时为 null，不是 0 —— 当监督标签用时 0 与 null 意思完全不同", () => {
    insLhb(t.db, "2026-08-03", "002131", "1", 5e7, { d1: 2.5 });
    const r = createSqliteView(t.db, "2026-08-03").lhb("2026-08-03")[0];
    expect(r.d1Chg).toBe(2.5);
    expect(r.d5Chg).toBeNull();
    expect(r.d10Chg).toBeNull();
    expect(r.d20Chg).toBeNull();
    expect(r.d30Chg).toBeNull();
  });

  it("lhbSeats 返回买卖两侧明细，同一营业部两行不折叠", () => {
    // 机构专用席位全部共用 dept_code='0'，按业务键去重必然丢行。
    insSeat(t.db, "2026-08-03", "002131", "1", "buy", "机构专用", 2e7);
    insSeat(t.db, "2026-08-03", "002131", "1", "buy", "机构专用", 1e7);
    insSeat(t.db, "2026-08-03", "002131", "1", "sell", "华鑫证券上海分公司", -8e6, { riseProb3d: 70 });
    const rows = createSqliteView(t.db, "2026-08-03").lhbSeats("2026-08-03");
    expect(rows).toHaveLength(3);
    expect(rows.filter(r => r.side === "buy")).toHaveLength(2);
    expect(rows.find(r => r.side === "sell")!.riseProb3d).toBe(70);
  });
});

describe("macro", () => {
  it("表为空时返回空数组，不抛错 —— 外围市场上线起攒，没有历史", () => {
    expect(createSqliteView(t.db, "2026-08-03").macro("A50", 5)).toEqual([]);
  });

  it("升序返回最近 n 条", () => {
    insMacro(t.db, "2026-08-01 09:00:00", "A50", 12900, 0.1);
    insMacro(t.db, "2026-08-02 09:00:00", "A50", 13000, 0.8);
    insMacro(t.db, "2026-08-03 09:00:00", "A50", 12950, -0.4);
    const rows = createSqliteView(t.db, "2026-08-03 15:00:00").macro("A50", 2);
    expect(rows.map(r => r.pct)).toEqual([0.8, -0.4]);
  });
});

describe("universe / security", () => {
  it("board 用库里的值，非法值按代码前缀推 —— bootstrap 只写了 name/board", () => {
    insSecurity(t.db, "688111", { board: "" });
    insSecurity(t.db, "301999", { board: "垃圾值" });
    insSecurity(t.db, "830799", { board: "未知板" });
    insSecurity(t.db, "600183", { board: "主板" });
    const view = createSqliteView(t.db, "2026-08-03");
    expect(view.security("688111")!.board).toBe("科创板");
    expect(view.security("301999")!.board).toBe("创业板");
    expect(view.security("830799")!.board).toBe("北交所");
    expect(view.security("600183")!.board).toBe("主板");
  });

  it("list_date 未知（NULL）时仍在池，但计入 universeQuality 的未知数", () => {
    // bootstrap 的 clist 不带 list_date，实测全库 list_date 都是 NULL。
    // 若把 NULL 当"未上市"排除，universe() 会返回空 —— 那是静默的灾难性失败。
    // 所以放行，但把未知量露出来，让回测报告能标注幸存者过滤实际有多少覆盖。
    insSecurity(t.db, "600183", { listDate: null });
    insSecurity(t.db, "600000", { listDate: "2010-01-01" });
    const view = createSqliteView(t.db, "2026-08-03");
    expect(view.universe().map(s => s.code).sort()).toEqual(["600000", "600183"]);
    expect(universeQuality(t.db, "2026-08-03")).toEqual({
      total: 2, unknownListDate: 1, unknownRatio: 0.5,
    });
  });

  it("isStHistory 解析 JSON", () => {
    insSecurity(t.db, "600000", {
      stJson: JSON.stringify([{ from: "2021-04-30", to: "2022-06-01" }, { from: "2023-05-06", to: null }]),
    });
    expect(createSqliteView(t.db, "2026-08-03").security("600000")!.isStHistory).toEqual([
      { from: "2021-04-30", to: "2022-06-01" },
      { from: "2023-05-06", to: null },
    ]);
  });

  it("is_st_history_json 为 NULL / 坏 JSON / 结构不对时返回 []，不抛错", () => {
    insSecurity(t.db, "600001", { stJson: null });
    insSecurity(t.db, "600002", { stJson: "{不是JSON" });
    insSecurity(t.db, "600003", { stJson: JSON.stringify({ from: "2021-01-01" }) });
    insSecurity(t.db, "600004", { stJson: JSON.stringify(["2021-01-01"]) });
    const view = createSqliteView(t.db, "2026-08-03");
    for (const code of ["600001", "600002", "600003", "600004"]) {
      expect(view.security(code)!.isStHistory, code).toEqual([]);
    }
  });

  it("security 查不到返回 null", () => {
    expect(createSqliteView(t.db, "2026-08-03").security("999999")).toBeNull();
  });

  it("universe 按 code 升序 —— 排序不稳定会让回测结果哈希抖动", () => {
    insSecurity(t.db, "600183");
    insSecurity(t.db, "000001");
    insSecurity(t.db, "300750");
    expect(createSqliteView(t.db, "2026-08-03").universe().map(s => s.code))
      .toEqual(["000001", "300750", "600183"]);
  });
});

describe("交易日历", () => {
  it("tradingDays 只取开市日，升序", () => {
    insCalendar(t.db, ["2026-07-31", "2026-08-03"]);
    insCalendar(t.db, ["2026-08-01", "2026-08-02"], 0);
    expect(createSqliteView(t.db, "2026-08-03").tradingDays("2026-07-01", "2026-08-03"))
      .toEqual(["2026-07-31", "2026-08-03"]);
  });

  it("prevTradingDay 严格早于给定日期，back 可回溯多天", () => {
    insCalendar(t.db, ["2026-07-29", "2026-07-30", "2026-07-31", "2026-08-03"]);
    const view = createSqliteView(t.db, "2026-08-03");
    expect(view.prevTradingDay("2026-08-03")).toBe("2026-07-31");
    expect(view.prevTradingDay("2026-08-03", 2)).toBe("2026-07-30");
    expect(view.prevTradingDay("2026-08-03", 99)).toBeNull();
    expect(view.prevTradingDay("2026-07-29")).toBeNull();
  });

  it("back < 1 返回 null，不悄悄当成 1", () => {
    insCalendar(t.db, ["2026-07-31", "2026-08-03"]);
    expect(createSqliteView(t.db, "2026-08-03").prevTradingDay("2026-08-03", 0)).toBeNull();
  });
});

describe("hasGap", () => {
  it("未修复的缺口为 true，已修复为 false", () => {
    insGap(t.db, "2026-08-03", "eastmoney", "zt_pool");
    insGap(t.db, "2026-07-31", "eastmoney", "zt_pool", true);
    const view = createSqliteView(t.db, "2026-08-03");
    expect(view.hasGap("2026-08-03")).toBe(true);
    expect(view.hasGap("2026-07-31")).toBe(false);
  });

  it("kind 可选，给了就只看那一类", () => {
    insGap(t.db, "2026-08-03", "eastmoney", "zt_pool");
    const view = createSqliteView(t.db, "2026-08-03");
    expect(view.hasGap("2026-08-03", "zt_pool")).toBe(true);
    expect(view.hasGap("2026-08-03", "lhb")).toBe(false);
  });

  it("gapKinds 列出某日的缺口种类 —— 契约只有布尔 hasGap，写具体警告要靠它", () => {
    // 不挂在视图上：PointInTimeView 是冻结契约，策略层只能用 hasGap(date, kind) 逐类问。
    // 这个函数给 UI / 回测覆盖率报告用。
    insGap(t.db, "2026-08-03", "eastmoney", "zt_pool");
    insGap(t.db, "2026-08-03", "sina", "kline_min:600183");
    insGap(t.db, "2026-08-03", "sina", "resolved_one", true);
    expect(gapKinds(t.db, "2026-08-03").sort()).toEqual(["kline_min:600183", "zt_pool"]);
  });
});

/**
 * 同一个视图实例内的记忆化。
 *
 * 起因是实测：跑一次今日信号卡，engine 调了 dailyBars **29,558 次**，
 * 而去重后只有 5,951 个 (code, n) 组合 —— 其中 29,440 次是同一个 n=9。
 * 一次请求里同样的问题问了五遍，1.6 秒全花在重复查询上，/today 因此要 0.9~1.6 秒。
 *
 * 缓存在语义上是安全的，因为这**就是** point-in-time 视图的定义：
 * 同一个 asOf、同样的参数，答案按契约必须相同。顺带还消掉了撕裂读 ——
 * 采集进程正在往库里写，同一次渲染里前后两次问同一个问题本来可能拿到不同的行。
 */
describe("视图内记忆化", () => {
  it("同参数重复调用返回相同内容", () => {
    insDaily(t.db, "600183", "2026-08-03", 13);
    insDaily(t.db, "600183", "2026-08-04", 14);
    const v = createSqliteView(t.db, "2026-08-04");
    expect(v.dailyBars("600183", 2)).toEqual(v.dailyBars("600183", 2));
    expect(v.dailyBars("600183", 2)).toHaveLength(2);
  });

  it("同一个视图内看到的是同一份快照：建视图之后写进去的行不会中途冒出来", () => {
    insDaily(t.db, "600183", "2026-08-03", 13);
    const v = createSqliteView(t.db, "2026-08-04");
    expect(v.dailyBars("600183", 5)).toHaveLength(1);
    insDaily(t.db, "600183", "2026-08-04", 14);
    // 渲染到一半突然多出一根 K 线，比"少一根"更难查：同一张页面上两个面板会各说各的
    expect(v.dailyBars("600183", 5)).toHaveLength(1);
  });

  it("不同参数各自独立，不会把 n 小的答案当成 n 大的", () => {
    insDaily(t.db, "600183", "2026-08-03", 13);
    insDaily(t.db, "600183", "2026-08-04", 14);
    const v = createSqliteView(t.db, "2026-08-04");
    expect(v.dailyBars("600183", 1)).toHaveLength(1);
    expect(v.dailyBars("600183", 2)).toHaveLength(2);
    expect(v.dailyBars("600183", 1)).toHaveLength(1);
  });

  it("调用方改动拿到的数组，不会污染下一次调用", () => {
    insDaily(t.db, "600183", "2026-08-03", 13);
    insDaily(t.db, "600183", "2026-08-04", 14);
    const v = createSqliteView(t.db, "2026-08-04");
    const first = v.dailyBars("600183", 2);
    first.reverse();
    first.pop();
    const second = v.dailyBars("600183", 2);
    expect(second).toHaveLength(2);
    expect(second[0].date).toBe("2026-08-03");
  });

  it("universe / quote 同样只问一次库", () => {
    insSecurity(t.db, "600183", { listDate: "2020-01-01" });
    insQuote(t.db, "600183", "2026-08-04 09:40:00.000", 13);
    const v = createSqliteView(t.db, "2026-08-04 10:00:00");
    expect(v.universe().map((s) => s.code)).toEqual(["600183"]);
    insSecurity(t.db, "600999", { listDate: "2020-01-01" });
    expect(v.universe().map((s) => s.code)).toEqual(["600183"]);

    const q1 = v.quote("600183");
    insQuote(t.db, "600183", "2026-08-04 09:50:00.000", 99);
    expect(v.quote("600183")).toEqual(q1);
  });
});
