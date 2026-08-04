import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb } from "@/lib/db";
import { runMigrations } from "@/lib/db/migrate";
import { syncCalendar, isTradingDay, tradingDaysBetween, latestTradingDay, ensureTradingDay }
  from "@/lib/data/calendar";

let dir: string, db: any;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "pt-"));
  db = openDb(path.join(dir, "t.db"));
  runMigrations(db);
});
afterEach(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });

const INDEX_JSON = JSON.stringify([
  { day: "2026-07-27", open: "1", high: "1", low: "1", close: "1", volume: "1" },
  { day: "2026-07-28", open: "1", high: "1", low: "1", close: "1", volume: "1" },
  { day: "2026-07-29", open: "1", high: "1", low: "1", close: "1", volume: "1" },
  { day: "2026-07-30", open: "1", high: "1", low: "1", close: "1", volume: "1" },
  { day: "2026-07-31", open: "1", high: "1", low: "1", close: "1", volume: "1" },
]);

const stubClient = {
  source: "sina",
  breaker: { isOpen: () => false, record() {}, reset() {} } as any,
  async get() { return { ok: true as const, text: INDEX_JSON, status: 200, latencyMs: 3 }; },
};

describe("calendar", () => {
  it("syncCalendar 请求的是上证指数 sh000001，不是 sz000001(平安银行)", async () => {
    const urls: string[] = [];
    const spy = {
      source: "sina",
      breaker: { isOpen: () => false, record() {}, reset() {} } as any,
      async get(url: string) {
        urls.push(url);
        return { ok: true as const, text: INDEX_JSON, status: 200, latencyMs: 3 };
      },
    };
    await syncCalendar(db, spy as any);
    expect(urls[0]).toContain("symbol=sh000001");
    expect(urls[0]).not.toContain("sz000001");
  });

  it("syncCalendar 从指数日线写入交易日", async () => {
    const n = await syncCalendar(db, stubClient as any);
    expect(n).toBe(5);
    expect(isTradingDay(db, "2026-07-29")).toBe(true);
  });

  it("未收录的日期视为非交易日", async () => {
    await syncCalendar(db, stubClient as any);
    expect(isTradingDay(db, "2026-08-01")).toBe(false);   // 周六
  });

  it("tradingDaysBetween 返回闭区间内的交易日", async () => {
    await syncCalendar(db, stubClient as any);
    expect(tradingDaysBetween(db, "2026-07-28", "2026-07-30"))
      .toEqual(["2026-07-28", "2026-07-29", "2026-07-30"]);
  });

  it("latestTradingDay 取不晚于给定日期的最近交易日", async () => {
    await syncCalendar(db, stubClient as any);
    expect(latestTradingDay(db, "2026-08-02")).toBe("2026-07-31");
  });

  it("没有任何交易日时 latestTradingDay 返回 null", () => {
    expect(latestTradingDay(db, "2026-08-02")).toBe(null);
  });

  describe("ensureTradingDay 盘中兜底", () => {
    /** 造一条带指定行情时间戳的 gtimg 报文 */
    const gtimgWithTs = (ts: string) => {
      const f = Array(88).fill("1");
      f[1] = "上证指数"; f[2] = "000001"; f[3] = "3796"; f[30] = ts;
      return `v_sh000001="${f.join("~")}";`;
    };

    const probeClient = (ts: string) => ({
      source: "tencent",
      breaker: { isOpen: () => false, record() {}, reset() {} } as any,
      async get() { return { ok: true as const, text: gtimgWithTs(ts), status: 200, latencyMs: 1 }; },
    });

    it("表里有记录时直接用表，不打网络", async () => {
      db.prepare("INSERT INTO trading_calendar (date,is_open,source) VALUES ('2026-07-31',1,'t')").run();
      let called = false;
      const spy = {
        source: "tencent",
        breaker: { isOpen: () => false, record() {}, reset() {} } as any,
        async get() { called = true; return { ok: true as const, text: "", status: 200, latencyMs: 1 }; },
      };
      expect(await ensureTradingDay(db, spy as any, "2026-07-31", true)).toBe(true);
      expect(called).toBe(false);
    });

    it("当日无记录且行情时间戳是今天 → 判为交易日并回写", async () => {
      const ok = await ensureTradingDay(db, probeClient("20260803140706") as any, "2026-08-03", true);
      expect(ok).toBe(true);
      const row = db.prepare("SELECT * FROM trading_calendar WHERE date='2026-08-03'").get() as any;
      expect(row.is_open).toBe(1);
      expect(row.source).toBe("gtimg_probe");
    });

    it("当日无记录且行情时间戳停在前一日 → 判为非交易日", async () => {
      const ok = await ensureTradingDay(db, probeClient("20260731150000") as any, "2026-08-01", true);
      expect(ok).toBe(false);
      const row = db.prepare("SELECT * FROM trading_calendar WHERE date='2026-08-01'").get() as any;
      expect(row.is_open).toBe(0);
    });

    it("历史日期无记录就是没开市，不做兜底探测", async () => {
      let called = false;
      const spy = {
        source: "tencent",
        breaker: { isOpen: () => false, record() {}, reset() {} } as any,
        async get() { called = true; return { ok: true as const, text: "", status: 200, latencyMs: 1 }; },
      };
      expect(await ensureTradingDay(db, spy as any, "2024-01-01", false)).toBe(false);
      expect(called).toBe(false);
    });
  });

  it("重复同步幂等，不产生重复行", async () => {
    await syncCalendar(db, stubClient as any);
    await syncCalendar(db, stubClient as any);
    const c = db.prepare("SELECT COUNT(*) n FROM trading_calendar").get() as any;
    expect(c.n).toBe(5);
  });
});

describe("ensureTradingDay：开盘前的负面探测不许落库", () => {
  // 2026-08-04 真实事故复现：preopen 09:00 探测（集合竞价还没开始），
  // 行情时间戳停在上一场 → 判"非交易日"并缓存 → 之后 48 个 intraday job 全跳过，
  // 不可回补的全市场快照丢了一上午。
  const YESTERDAY_TS = "20260803150000";
  const TODAY_TS = "20260804101500";

  function quoteClient(ts: string) {
    const f = Array(88).fill("1");
    f[1] = "上证指数"; f[2] = "000001"; f[3] = "3830.24";
    f[30] = ts;
    return {
      source: "tencent",
      breaker: { isOpen: () => false, record() {}, reset() {} } as any,
      async get() {
        return { ok: true as const, text: `v_sh000001="${f.join("~")}";`, status: 200, latencyMs: 1 };
      },
    };
  }

  const at = (hm: string) => new Date(`2026-08-04T${hm}:00+08:00`);

  it("09:00 探测说没开 → 返回 false 但不写日历", async () => {
    const open = await ensureTradingDay(
      db, quoteClient(YESTERDAY_TS) as any, "2026-08-04", true, at("09:00"));
    expect(open).toBe(false);
    const row = db.prepare("SELECT * FROM trading_calendar WHERE date='2026-08-04'").get();
    expect(row).toBeUndefined();   // 没落库，才有机会被后面的 job 纠正
  });

  it("同一天 10:15 再探，行情已滚到今天 → 判开市并落库", async () => {
    await ensureTradingDay(db, quoteClient(YESTERDAY_TS) as any, "2026-08-04", true, at("09:00"));
    const open = await ensureTradingDay(
      db, quoteClient(TODAY_TS) as any, "2026-08-04", true, at("10:15"));
    expect(open).toBe(true);
    const row = db.prepare("SELECT is_open FROM trading_calendar WHERE date='2026-08-04'").get() as any;
    expect(row.is_open).toBe(1);
  });

  it("过了 09:35 仍停在上一场 → 才认定休市并落库", async () => {
    const open = await ensureTradingDay(
      db, quoteClient(YESTERDAY_TS) as any, "2026-08-04", true, at("09:40"));
    expect(open).toBe(false);
    const row = db.prepare("SELECT is_open, source FROM trading_calendar WHERE date='2026-08-04'").get() as any;
    expect(row.is_open).toBe(0);
    expect(row.source).toBe("gtimg_probe");
  });

  it("探测写下的 is_open=0 不被信任，会重探并纠正", async () => {
    // 模拟事故现场：库里已有一行被开盘前写坏的 0
    db.prepare("INSERT INTO trading_calendar (date,is_open,source) VALUES ('2026-08-04',0,'gtimg_probe')").run();
    const open = await ensureTradingDay(
      db, quoteClient(TODAY_TS) as any, "2026-08-04", true, at("10:15"));
    expect(open).toBe(true);
  });

  it("日线反推的权威日历不重探，直接采信", async () => {
    db.prepare("INSERT INTO trading_calendar (date,is_open,source) VALUES ('2026-08-04',0,'sina_index')").run();
    let called = false;
    const spy = { source: "t", async get() { called = true; throw new Error("不该探测"); } };
    expect(await ensureTradingDay(db, spy as any, "2026-08-04", true, at("10:15"))).toBe(false);
    expect(called).toBe(false);
  });

  it("周末不探测，直接判休市", async () => {
    let called = false;
    const spy = { source: "t", async get() { called = true; throw new Error("不该探测"); } };
    // 2026-08-08 是周六
    expect(await ensureTradingDay(db, spy as any, "2026-08-08", true, at("10:15"))).toBe(false);
    expect(called).toBe(false);
    const row = db.prepare("SELECT source FROM trading_calendar WHERE date='2026-08-08'").get() as any;
    expect(row.source).toBe("weekend");
  });
});
