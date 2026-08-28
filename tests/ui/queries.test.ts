import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import {
  accounts,
  calendarRange,
  dailyBars,
  getMetaValue,
  lastTradingDay,
  latestLhbDate,
  latestQuoteTs,
  latestQuotes,
  latestZtDate,
  lhbRows,
  lhbSeats,
  positions,
  predictionTimeline,
  searchSecurities,
  sectorRank,
  securities,
  settledPredictions,
  sourceHealth,
  strategies,
  tableCounts,
  tableCountsCached,
  trades,
  unresolvedGaps,
  watchpool,
  ztPool,
} from "@/lib/ui/queries";
import { refreshTableCounts, readTableCountsSnapshot, TABLE_COUNTS_KEY } from "@/lib/data/table-counts";
import { setMeta } from "@/lib/data/meta";
import { winRateStats } from "@/lib/ui/adapters/ledger";
import { recordManualFill, upsertAccount, upsertWatch, deactivateWatch } from "@/lib/ui/mutations";

/**
 * 读层与写层的测试。**跑在临时库上** —— 绝不碰 ~/PanTraderData/pantrader.db：
 * 那里面有不可回补的历史（分钟线/涨停池/台账），测试写坏了没法恢复。
 */

let dir: string;
let dbPath: string;
let db: Database.Database;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "pantrader-ui-test-"));
  dbPath = path.join(dir, "t.db");
  db = new Database(dbPath);
  db.pragma("foreign_keys = ON");
  runMigrations(db);
});

afterAll(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("空库：一律返回空，绝不造默认行", () => {
  it("所有列表查询返回空数组 / 空 Map / null", () => {
    expect(ztPool(db, "2026-08-03")).toEqual([]);
    expect(lhbRows(db, "2026-08-03")).toEqual([]);
    expect(lhbSeats(db, "2026-08-03")).toEqual([]);
    expect(sectorRank(db, "2026-08-03")).toEqual([]);
    expect(dailyBars(db, "600519", 10)).toEqual([]);
    expect(positions(db)).toEqual([]);
    expect(accounts(db)).toEqual([]);
    expect(watchpool(db)).toEqual([]);
    expect(strategies(db)).toEqual([]);
    expect(trades(db)).toEqual([]);
    expect(predictionTimeline(db)).toEqual([]);
    expect(unresolvedGaps(db)).toEqual([]);
    expect(sourceHealth(db, "2026-01-01T00:00:00Z")).toEqual([]);
    expect(latestQuotes(db, ["600519"]).size).toBe(0);
    expect(securities(db, ["600519"]).size).toBe(0);
    expect(latestQuoteTs(db)).toBeNull();
    expect(latestZtDate(db)).toBeNull();
    expect(latestLhbDate(db)).toBeNull();
    expect(getMetaValue(db, "system_start_date")).toBeNull();
  });

  it("空 codes 不发查询也不报错", () => {
    expect(latestQuotes(db, []).size).toBe(0);
    expect(securities(db, []).size).toBe(0);
  });

  it("胜率在零样本时是 null，不是 0%", () => {
    expect(settledPredictions(db)).toEqual([]);
    expect(winRateStats(db)).toBeNull();
  });

  it("表行数能数出来（-1 表示缺表）", () => {
    const c = tableCounts(db);
    expect(c.find((x) => x.table === "security")!.rows).toBe(0);
    expect(c.every((x) => x.rows >= 0)).toBe(true);
  });
});

describe("行情读取", () => {
  beforeAll(() => {
    db.prepare(
      `INSERT INTO security (code, name, list_date, delist_date, board, is_st_history_json)
       VALUES (?,?,?,?,?,?)`
    ).run("600519", "贵州茅台", "2001-08-27", null, "主板", '[{"from":"2015-01-01","to":null}]');
    db.prepare(
      "INSERT INTO security (code, name, board) VALUES (?,?,?)"
    ).run("300613", "富瀚微", "创业板");
    // 同一只票两个时点的快照：必须取最新那个
    const q = db.prepare(
      "INSERT INTO quote_snapshot (ts, code, price, pct, turnover, amplitude) VALUES (?,?,?,?,?,?)"
    );
    q.run("2026-08-03T05:00:00Z", "600519", 1400, 1.0, 0.5, 2.0);
    q.run("2026-08-03T07:10:00Z", "600519", 1450, 2.0, 0.6, 2.5);
    // 坏行：price 为 0（解析失败或停牌），不许交给界面
    q.run("2026-08-03T07:10:00Z", "300613", 0, 0, 0, 0);

    const k = db.prepare(
      "INSERT INTO kline_daily (code, date, o,h,l,c,vol,amount,adj_factor) VALUES (?,?,?,?,?,?,?,?,?)"
    );
    for (const [i, d] of ["2026-07-30", "2026-07-31", "2026-08-03"].entries()) {
      k.run("600519", d, 100 + i, 105 + i, 99 + i, 104 + i, 1e6, 1e8, 1);
    }

    db.prepare(
      `INSERT INTO zt_pool (date, code, name, lbc, seal_amt, open_times, first_seal_ts, last_seal_ts, sector, turnover)
       VALUES (?,?,?,?,?,?,?,?,?,?)`
    ).run("2026-08-03", "003032", "传智教育", 6, 1.99e8, 0, "09:30", "09:30", "教育", 3.2);

    const cal = db.prepare("INSERT INTO trading_calendar (date, is_open, source) VALUES (?,?,?)");
    cal.run("2026-08-01", 0, "test"); // 周六
    cal.run("2026-08-03", 1, "test");
    cal.run("2026-08-04", 1, "test");
  });

  it("逐票取最新快照，时间戳归一为上海挂钟", () => {
    const m = latestQuotes(db, ["600519"]);
    expect(m.get("600519")!.price).toBe(1450);
    // 读层统一输出挂钟串（库里可能是 006 之前的 UTC ISO）：
    // 不归一的话 'T' > ' ' 会让老 ISO 行排到挂钟行后面，取成过期价
    expect(m.get("600519")!.ts).toBe("2026-08-03 15:10:00.000");
    expect(latestQuoteTs(db)).toBe("2026-08-03 15:10:00.000");
  });

  it("混合口径下仍取真正最新的那条（不被字符串比较骗）", () => {
    // 挂钟串 08-03 15:20（真正最新）vs UTC 串 08-03T08:00Z（= 16:00 挂钟，更新）
    db.prepare(
      "INSERT INTO quote_snapshot (ts, code, price, pct, turnover, amplitude) VALUES (?,?,?,?,?,?)"
    ).run("2026-08-03 15:20:00.000", "600519", 1460, 2.1, 0.6, 2.5);
    expect(latestQuotes(db, ["600519"]).get("600519")!.price).toBe(1460);

    db.prepare(
      "INSERT INTO quote_snapshot (ts, code, price, pct, turnover, amplitude) VALUES (?,?,?,?,?,?)"
    ).run("2026-08-03T08:00:00Z", "600519", 1470, 2.2, 0.6, 2.5);
    // 16:00 挂钟 > 15:20 挂钟，所以该取 1470 —— 纯字符串比较会错取 15:20 那条
    expect(latestQuotes(db, ["600519"]).get("600519")!.price).toBe(1470);
  });

  it("price<=0 的坏快照被丢弃，而不是当成 0 价交出去", () => {
    const m = latestQuotes(db, ["300613"]);
    expect(m.has("300613")).toBe(false);
  });

  it("日线按契约升序返回", () => {
    const bars = dailyBars(db, "600519", 10);
    expect(bars.map((b) => b.date)).toEqual(["2026-07-30", "2026-07-31", "2026-08-03"]);
    expect(bars[0].adjFactor).toBe(1);
  });

  it("涨停池映射到契约字段名", () => {
    const rows = ztPool(db, "2026-08-03");
    expect(rows[0]).toMatchObject({ code: "003032", lbc: 6, openTimes: 0, sector: "教育" });
    expect(rows[0].sealAmt).toBe(1.99e8);
    expect(rows[0].name).toBe("传智教育");
  });

  it("ST 历史 JSON 解析失败不炸页面", () => {
    db.prepare("UPDATE security SET is_st_history_json = ? WHERE code = ?").run("{坏JSON", "300613");
    expect(securities(db, ["300613"]).get("300613")!.isStHistory).toEqual([]);
  });

  it("交易日历：取 asOf 及之前最近的开市日", () => {
    // 08-01 是周六（is_open=0），所以 08-02 之前没有开市日 → null，不回落到休市日
    expect(lastTradingDay(db, "2026-08-02")).toBeNull();
    expect(lastTradingDay(db, "2026-08-03")).toBe("2026-08-03");
    expect(lastTradingDay(db, "2026-08-05")).toBe("2026-08-04");
    expect(calendarRange(db)).toEqual({ from: "2026-08-01", to: "2026-08-04", openDays: 2 });
  });

  it("搜索走绑定参数：SQL 元字符不会被当语法执行", () => {
    expect(() => searchSecurities(db, "'; DROP TABLE security; --")).not.toThrow();
    expect(tableCounts(db).find((x) => x.table === "security")!.rows).toBeGreaterThan(0);
    expect(searchSecurities(db, "茅台").map((s) => s.code)).toEqual(["600519"]);
  });
});

describe("龙虎榜：一票一原因一行，不按代码去重", () => {
  beforeAll(() => {
    const l = db.prepare(
      `INSERT INTO lhb (date, code, change_type, name, explanation, explain_stat,
        net_amt, buy_amt, sell_amt, turnover_rate, deal_amount_ratio, close_price, change_rate)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
    );
    l.run("2026-08-03", "002131", "T1", "利欧股份", "日换手率达到20%的前5只证券", "3家机构买入", 1e7, 2e7, 1e7, 21.5, 0.3, 3.1, 9.9);
    l.run("2026-08-03", "002131", "T2", "利欧股份", "日涨幅偏离值达到7%的前5只证券", "", 5e6, 1e7, 5e6, 21.5, 0.2, 3.1, 9.9);
  });

  it("同票同日多行都在", () => {
    const rows = lhbRows(db, "2026-08-03");
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => r.changeType))).toEqual(new Set(["T1", "T2"]));
  });

  it("上榜当日的 D1/D5 是 null（尚未回填），不是 0", () => {
    const rows = lhbRows(db, "2026-08-03");
    expect(rows[0].d1Chg).toBeNull();
    expect(rows[0].d5Chg).toBeNull();
  });

  it("explanation 与 explain_stat 不混用", () => {
    const r = lhbRows(db, "2026-08-03").find((x) => x.changeType === "T1")!;
    expect(r.explanation).toContain("换手率");
    expect(r.explainStat).toContain("机构");
  });
});

describe("缺口：不可回补的排在最前", () => {
  beforeAll(() => {
    const g = db.prepare(
      `INSERT INTO data_gap (date, source, kind, reason, recoverable, detected_at, resolved_at)
       VALUES (?,?,?,?,?,?,?)`
    );
    g.run("2026-08-03", "sina", "kline_daily:001232", "payload 异常", 1, "2026-08-03T14:00:00Z", null);
    g.run("2026-08-02", "eastmoney", "zt_pool", "调度未运行", 0, "2026-08-03T01:00:00Z", null);
    g.run("2026-08-01", "sina", "kline_daily:x", "已修", 1, "2026-08-01T01:00:00Z", "2026-08-01T02:00:00Z");
  });

  it("只列未解决的，不可回补优先", () => {
    const rows = unresolvedGaps(db);
    expect(rows).toHaveLength(2);
    expect(rows[0].recoverable).toBe(false);
    expect(rows[0].kind).toBe("zt_pool");
  });
});

describe("源健康聚合", () => {
  beforeAll(() => {
    const h = db.prepare(
      "INSERT INTO source_health (source, ts, ok, latency_ms, err) VALUES (?,?,?,?,?)"
    );
    h.run("sina", "2026-08-03T00:00:00Z", 1, 100, null);
    h.run("sina", "2026-08-03T01:00:00Z", 0, 900, "timeout");
    h.run("eastmoney", "2026-08-03T01:00:00Z", 1, 200, null);
  });

  it("取每个源的最后一次 + 窗口成功率", () => {
    const rows = sourceHealth(db, "2026-08-01T00:00:00Z");
    const sina = rows.find((r) => r.source === "sina")!;
    expect(sina.lastTs).toBe("2026-08-03 09:00:00.000");
    expect(sina.lastOk).toBe(false);
    expect(sina.lastErr).toBe("timeout");
    expect(sina.windowN).toBe(2);
    expect(sina.okRate).toBeCloseTo(0.5, 10);
    // 平均延迟只统计成功的请求：把超时的 900ms 算进来会掩盖真实延迟
    expect(sina.avgLatencyMs).toBe(100);
  });

  it("窗口内无样本时成功率是 null 而不是 0", () => {
    const rows = sourceHealth(db, "2027-01-01T00:00:00Z");
    for (const r of rows) expect(r.okRate).toBeNull();
  });
});

describe("写路径：观察池 / 账户 / 手工成交回填", () => {
  it("观察池 upsert 与软删", () => {
    upsertWatch(db, {
      code: "600468",
      name: "百利电气",
      account: "卫星",
      triggerPx: 5.8,
      stopPx: 5.51,
      thesis: "电网主线回踩",
    });
    let rows = watchpool(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ code: "600468", triggerPx: 5.8, stopPx: 5.51, active: true });

    upsertWatch(db, { code: "600468", account: "核心", triggerPx: 5.6 });
    rows = watchpool(db);
    expect(rows).toHaveLength(1);
    expect(rows[0].account).toBe("核心");
    expect(rows[0].triggerPx).toBe(5.6);

    deactivateWatch(db, "600468");
    expect(watchpool(db)).toHaveLength(0);
    // 软删：历史仍在，供复盘
    expect(watchpool(db, true)).toHaveLength(1);
  });

  it("买入按加权平均摊成本，且把费用摊进去", () => {
    upsertAccount(db, { id: "zw", name: "卫星主号", type: "卫星" });
    expect(accounts(db).map((a) => a.id)).toContain("zw");

    recordManualFill(db, { accountId: "zw", code: "600468", side: "buy", px: 10, qty: 1000, fee: 5 });
    let p = positions(db).find((x) => x.code === "600468")!;
    expect(p.qty).toBe(1000);
    expect(p.cost).toBeCloseTo(10.005, 6); // 费用不摊进成本会让止损线偏乐观

    recordManualFill(db, { accountId: "zw", code: "600468", side: "buy", px: 12, qty: 1000, fee: 0 });
    p = positions(db).find((x) => x.code === "600468")!;
    expect(p.qty).toBe(2000);
    expect(p.cost).toBeCloseTo(11.0025, 6);
  });

  it("卖出只减量不改成本基准", () => {
    const before = positions(db).find((x) => x.code === "600468")!;
    recordManualFill(db, { accountId: "zw", code: "600468", side: "sell", px: 13, qty: 500 });
    const after = positions(db).find((x) => x.code === "600468")!;
    expect(after.qty).toBe(before.qty - 500);
    expect(after.cost).toBeCloseTo(before.cost, 10);
  });

  it("卖超持仓直接抛错，不静默截断数量", () => {
    expect(() =>
      recordManualFill(db, { accountId: "zw", code: "600468", side: "sell", px: 13, qty: 999999 })
    ).toThrow(/超过持仓/);
    // 抛错后事务回滚，持仓不受影响
    expect(positions(db).find((x) => x.code === "600468")!.qty).toBe(1500);
  });

  it("没有持仓时卖出抛错", () => {
    expect(() =>
      recordManualFill(db, { accountId: "zw", code: "999999", side: "sell", px: 1, qty: 100 })
    ).toThrow(/没有持仓可卖/);
  });

  it("卖光后删除持仓行，并留下成交记录", () => {
    recordManualFill(db, { accountId: "zw", code: "600468", side: "sell", px: 13, qty: 1500 });
    expect(positions(db).find((x) => x.code === "600468")).toBeUndefined();
    const t = trades(db);
    expect(t.length).toBeGreaterThanOrEqual(4);
    expect(t.every((x) => x.source === "manual")).toBe(true);
  });

  /**
   * 这条原先断言的是 `.account === "卫星"`，也就是 account.type。
   *
   * 那是内置账户时代的遗留：当时 type 恰好等于 YAML `持仓:` 段的键，两者混用看不出问题。
   * 用户自建账户之后 type 变成自由文本标签（"短线"这种），而持仓页按 account.id 分组、
   * YAML 键名按 README 也该写成 id —— 于是"表里有持仓、页面显示无持仓"，
   * 且 accountRule 拿标签去查规则查不到，硬线告警静默失效。
   *
   * 所以锁的不变量是：**账户键空间只有一个，就是 account_id**。
   */
  it("持仓带出的 account 是 account_id，不是 type 标签（规则/分组都按 id）", () => {
    recordManualFill(db, { accountId: "zw", code: "601700", side: "buy", px: 5, qty: 100 });
    const p = positions(db).find((x) => x.code === "601700")!;
    expect(p.account).toBe("zw");
    expect(p.accountId).toBe("zw");
    // type 是展示标签，改它不该影响键
    upsertAccount(db, { id: "zw", name: "卫星主号", type: "短线" });
    expect(positions(db).find((x) => x.code === "601700")!.account).toBe("zw");
  });
});


/**
 * latestQuoteTs 单独开一个库：本文件其它 describe 用的是共享库、逐条累积，
 * 而"最新时间戳"这种全表聚合的断言一旦依赖前面测试插了什么，就变成顺序相关的假绿。
 */
describe("latestQuoteTs：最新快照时点", () => {
  let d2: string, db2: Database.Database;
  beforeAll(() => {
    d2 = fs.mkdtempSync(path.join(os.tmpdir(), "pantrader-lqts-"));
    db2 = new Database(path.join(d2, "t.db"));
    runMigrations(db2);
  });
  afterAll(() => { db2.close(); fs.rmSync(d2, { recursive: true, force: true }); });

  const put = (ts: string, code: string, price: number) =>
    db2.prepare(
      "INSERT INTO quote_snapshot (ts, code, price, pct, turnover, amplitude) VALUES (?,?,?,?,?,?)"
    ).run(ts, code, price, 0, 0, 0);

  it("空表返回 null，不返回空串", () => {
    expect(latestQuoteTs(db2)).toBeNull();
  });

  /**
   * 这条盯的是**性能塌方**，不只是取值对不对。
   *
   * 原实现是 `MAX(wall(ts))` —— 把列包进 CASE/strftime，主键 (ts, code) 的索引就用不上了。
   * 实测生产库 7,133,734 行：包了是 1.54 秒全扫，裸 MAX(ts) 走索引是 0.015 秒，同一个答案。
   * 而这个函数在根 layout 的 StatusRail、观察池页、持仓页都调，SSE 心跳还每 3 秒
   * 对每个连着的标签页调一次 —— 于是点完"加入观察池"，router.refresh() 要 2.2~8.1 秒
   * 才回，界面看起来就是"没刷新"。
   *
   * 所以全是挂钟串时必须走得到快路径；混合口径仍要退回归一比较保证取值正确。
   */
  it("全是挂钟串时取真正最新的那条", () => {
    put("2026-08-03 09:35:00.000", "600519", 1400);
    put("2026-08-03 15:05:00.000", "600519", 1450);
    put("2026-08-03 14:00:00.000", "300613", 30);
    expect(latestQuoteTs(db2)).toBe("2026-08-03 15:05:00.000");
  });

  it("混合口径：ISO 行更新时，归一成挂钟串再交出去", () => {
    // 08-03T08:00Z = 挂钟 16:00，比上面的 15:05 新
    put("2026-08-03T08:00:00Z", "600519", 1470);
    expect(latestQuoteTs(db2)).toBe("2026-08-03 16:00:00.000");
  });

  it("挂钟最大值早于 08:00 时不敢走快路径 —— 那时 ISO 行可能更新", () => {
    const d3 = fs.mkdtempSync(path.join(os.tmpdir(), "pantrader-lqts2-"));
    const db3 = new Database(path.join(d3, "t.db"));
    runMigrations(db3);
    const q = db3.prepare(
      "INSERT INTO quote_snapshot (ts, code, price, pct, turnover, amplitude) VALUES (?,?,?,?,?,?)"
    );
    // 挂钟 07:00（早于 08:00）；ISO 前一日 23:30Z = 挂钟当日 07:30，比它新，
    // 但字符串序里 '2026-08-02T…' < '2026-08-03 …'，裸 MAX 会取错
    q.run("2026-08-03 07:00:00.000", "600519", 1400, 0, 0, 0);
    q.run("2026-08-02T23:30:00Z", "600519", 1410, 0, 0, 0);
    expect(latestQuoteTs(db3)).toBe("2026-08-03 07:30:00.000");
    db3.close();
    fs.rmSync(d3, { recursive: true, force: true });
  });

  it("混合口径：ISO 行更旧时，不该把挂钟行顶掉", () => {
    put("2026-08-04 09:40:00.000", "600519", 1480);
    // 库里仍留着上一条 08-03T08:00Z（= 08-03 16:00），比 08-04 09:40 旧
    expect(latestQuoteTs(db2)).toBe("2026-08-04 09:40:00.000");
  });
});


/**
 * 源健康：生产形态（挂钟串）下的行为。
 *
 * 上面那组"源健康聚合"喂的是 migration 006 之前的 UTC ISO 串，而线上写入侧
 * 一律 shanghaiTs()、调用方（lib/ui/status.ts）传进来的 since 也是挂钟串 ——
 * 两组口径都得跑得对，否则改查询时会有一组无人看守。
 *
 * 这组同时是性能改造的看守：sourceHealth 原来把 wall(ts) 写进三个相关子查询的
 * WHERE 里，34 万行的表每次渲染扫三遍（实测 340ms，而它在根 layout 里）。
 * 改成对裸列做范围扫之后，下面这些断言必须一字不变地还成立。
 */
describe("源健康：挂钟串口径（线上真实形态）", () => {
  let d4: string, db4: Database.Database;
  beforeAll(() => {
    d4 = fs.mkdtempSync(path.join(os.tmpdir(), "pantrader-health-"));
    db4 = new Database(path.join(d4, "t.db"));
    runMigrations(db4);
    const h = db4.prepare(
      "INSERT INTO source_health (source, ts, ok, latency_ms, err) VALUES (?,?,?,?,?)"
    );
    // 窗口外（更早）：不该被计入 windowN，但仍可能是"最后一次"
    h.run("tencent", "2026-08-01 09:00:00.000", 1, 50, null);
    // 窗口内
    h.run("sina", "2026-08-03 09:35:00.000", 1, 100, null);
    h.run("sina", "2026-08-03 09:40:00.000", 0, 900, "timeout");
    h.run("sina", "2026-08-03 09:45:00.000", 1, 300, null);
    h.run("eastmoney", "2026-08-03 09:40:00.000", 1, 200, null);
  });
  afterAll(() => { db4.close(); fs.rmSync(d4, { recursive: true, force: true }); });

  const SINCE = "2026-08-02 00:00:00.000";

  it("每个源取最后一次的状态，不是窗口里随便一条", () => {
    const sina = sourceHealth(db4, SINCE).find((r) => r.source === "sina")!;
    expect(sina.lastTs).toBe("2026-08-03 09:45:00.000");
    expect(sina.lastOk).toBe(true);
    expect(sina.lastErr).toBeNull();
    expect(sina.lastLatencyMs).toBe(300);
  });

  it("窗口成功率按窗口内全部样本算", () => {
    const sina = sourceHealth(db4, SINCE).find((r) => r.source === "sina")!;
    expect(sina.windowN).toBe(3);
    expect(sina.windowOk).toBe(2);
    expect(sina.okRate).toBeCloseTo(2 / 3, 10);
    // 平均延迟只算成功的：把 timeout 的 900ms 混进来会掩盖真实延迟
    expect(sina.avgLatencyMs).toBe(200);
  });

  it("最后一次在窗口之外的源仍要出现，但窗口统计是空的", () => {
    const t = sourceHealth(db4, SINCE).find((r) => r.source === "tencent")!;
    expect(t.lastTs).toBe("2026-08-01 09:00:00.000");
    expect(t.windowN).toBe(0);
    // 无样本时成功率是 null 而不是 0 —— 0 会被读成"全挂了"
    expect(t.okRate).toBeNull();
    expect(t.avgLatencyMs).toBeNull();
  });

  it("按源名升序，界面上的顺序不能每次刷新都变", () => {
    expect(sourceHealth(db4, SINCE).map((r) => r.source)).toEqual(
      ["eastmoney", "sina", "tencent"]
    );
  });
});

/**
 * 行数统计。
 *
 * COUNT(*) 在 SQLite 里没有 O(1) 写法：kline_daily 已经在扫最窄的那个索引
 * （idx_kline_daily_date），5,750,482 行仍要 1.87s，quote_snapshot 7,133,734 行 0.69s，
 * 22 张表一轮实测 4.1–5.4 秒，且每次都要重付 —— 2.0 GB 的库比可用内存大，
 * 两次统计之间页缓存已经被挤掉。而 better-sqlite3 是同步的，这 4 秒钉死整个事件循环。
 *
 * 早先的做法是进程内缓存 60 秒、过期当场重数。实测那等于每分钟随机挑一个
 * 访问 /lab 或 /settings 的请求卡满四秒（连续访问 /lab，耗时在 4.1s 与 0.02s 之间按分钟交替），
 * 期间 SSE、别的页签、正在跑的回测流一起停摆。
 *
 * 现在真数一遍由夜间 job 做，结果写进 app_meta；页面只读快照。
 * tableCounts 本身保持每次真数（导出/校验依赖它说实话），
 * 而快照必须带上统计时刻并显示出来 —— 屏幕上是昨夜的数字没问题，
 * 假装它是此刻的才有问题。
 */
describe("tableCountsCached", () => {
  let d5: string, db5: Database.Database;
  beforeAll(() => {
    d5 = fs.mkdtempSync(path.join(os.tmpdir(), "pantrader-counts-"));
    db5 = new Database(path.join(d5, "t.db"));
    runMigrations(db5);
  });
  afterAll(() => { db5.close(); fs.rmSync(d5, { recursive: true, force: true }); });

  const addSec = (code: string) =>
    db5.prepare("INSERT INTO security (code, name, board) VALUES (?,?,?)").run(code, code, "主板");
  const secCount = (r: { counts: Array<{ table: string; rows: number }> }) =>
    r.counts.find((c) => c.table === "security")!.rows;
  /** 把 `YYYY-MM-DD HH:MM:SS.mmm`（上海）换回 epoch，方便按毫秒构造"多久以前" */
  const ms = (at: string) => Date.parse(`${at.slice(0, 10)}T${at.slice(11, 19)}+08:00`);

  it("没有快照时当场真数 —— 全新的库不能显示空白", () => {
    addSec("600001");
    expect(secCount(tableCountsCached(db5, 86_400_000, 0))).toBe(1);
  });

  it("有快照就读快照，不再扫表", () => {
    const snap = refreshTableCounts(db5);
    expect(secCount(snap)).toBe(1);
    // 快照写完之后再改库：读到的仍应是快照里的数，否则说明它偷偷重数了
    addSec("600002");
    const r = tableCountsCached(db5, 86_400_000, ms(snap.at) + 1_000);
    expect(secCount(r)).toBe(1);
    expect(r.at).toBe(snap.at);
  });

  it("快照太旧就当场重数 —— 夜间 job 一天没跑成，得看见真数字", () => {
    const snap = refreshTableCounts(db5);        // 此刻 security 有 2 行
    addSec("600003");
    const stale = tableCountsCached(db5, 60_000, ms(snap.at) + 3_600_000);
    expect(secCount(stale)).toBe(3);
    expect(stale.at).not.toBe(snap.at);
  });

  it("时间戳解析不出来一律当太旧，不拿来路不明的时刻当新鲜", () => {
    setMeta(db5, TABLE_COUNTS_KEY, JSON.stringify({ at: "不是时间", counts: [{ table: "security", rows: 999 }] }));
    expect(secCount(tableCountsCached(db5, 86_400_000, 0))).toBe(3);
  });

  it("坏掉的快照当作没有快照，不给出半份数据", () => {
    setMeta(db5, TABLE_COUNTS_KEY, "{ 这不是 JSON");
    expect(secCount(tableCountsCached(db5, 86_400_000, 0))).toBe(3);
    setMeta(db5, TABLE_COUNTS_KEY, JSON.stringify({ at: "2026-08-27 22:00:00.000" }));  // 缺 counts
    expect(secCount(tableCountsCached(db5, 86_400_000, 0))).toBe(3);
    expect(readTableCountsSnapshot(db5)).toBeNull();
  });

  it("带回统计时刻，页面要能显示这是什么时候数的", () => {
    expect(refreshTableCounts(db5).at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/);
  });

  it("兜底不会每个请求都真数一遍 —— 夜间 job 挂掉那天不能每分钟卡死四秒", () => {
    setMeta(db5, TABLE_COUNTS_KEY, "{ 坏的");   // 逼进兜底路径
    const t0 = 9_000_000_000_000;
    expect(secCount(tableCountsCached(db5, 86_400_000, t0))).toBe(3);
    addSec("600009");
    // 十分钟内的第二次调用不重数：拿到的还是上一次的数字和上一次的时刻
    const again = tableCountsCached(db5, 86_400_000, t0 + 60_000);
    expect(secCount(again)).toBe(3);
    // 过了节流窗口才重数
    expect(secCount(tableCountsCached(db5, 86_400_000, t0 + 900_000))).toBe(4);
    db5.prepare("DELETE FROM security WHERE code = ?").run("600009");
  });

  it("maxAgeMs=0 等于不看快照 —— 导出/校验那种场合必须每次真数", () => {
    refreshTableCounts(db5);
    addSec("600004");
    expect(secCount(tableCountsCached(db5, 0))).toBe(4);
    addSec("600005");
    expect(secCount(tableCountsCached(db5, 0))).toBe(5);
  });
});
