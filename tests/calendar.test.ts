import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb } from "@/lib/db";
import { runMigrations } from "@/lib/db/migrate";
import { syncCalendar, isTradingDay, tradingDaysBetween, latestTradingDay }
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

  it("重复同步幂等，不产生重复行", async () => {
    await syncCalendar(db, stubClient as any);
    await syncCalendar(db, stubClient as any);
    const c = db.prepare("SELECT COUNT(*) n FROM trading_calendar").get() as any;
    expect(c.n).toBe(5);
  });
});
