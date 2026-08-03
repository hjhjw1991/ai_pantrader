import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb } from "@/lib/db";
import { runMigrations } from "@/lib/db/migrate";
import { runJob, lhbRefreshDates, LHB_LABEL_OFFSETS } from "@/lib/data/jobs";

let dir: string, db: any;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "pt-"));
  db = openDb(path.join(dir, "t.db"));
  runMigrations(db);
  db.prepare("INSERT INTO trading_calendar (date, is_open, source) VALUES ('2026-07-31', 1, 't')").run();
});
afterEach(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });

const stub = (text: string) => ({
  source: "stub",
  breaker: { isOpen: () => false, record() {}, reset() {} } as any,
  async get() { return { ok: true as const, text, status: 200, latencyMs: 1 }; },
});

const clients = () => ({
  sina: stub("[]") as any,
  tencent: stub('v_sh601012="";') as any,
  eastmoney: stub(JSON.stringify({ data: { pool: [] }, result: { pages: 1, data: [] } })) as any,
});

describe("runJob", () => {
  it("非交易日直接跳过", async () => {
    const r = await runJob("close", { db, clients: clients(), now: new Date("2026-08-01T07:05:00Z") });
    expect(r.skipped).toBe(true);
    expect(r.reason).toMatch(/not a trading day/i);
  });

  it("交易日执行 close job 并返回统计", async () => {
    const r = await runJob("close", { db, clients: clients(), now: new Date("2026-07-31T07:05:00Z") });
    expect(r.skipped).toBe(false);
    expect(typeof r.stats).toBe("object");
    expect(r.stats).toHaveProperty("ztPoolRows");
  });

  it("selfcheck 不受交易日限制，总是执行", async () => {
    const r = await runJob("selfcheck", { db, clients: clients(), now: new Date("2026-08-01T00:50:00Z") });
    expect(r.skipped).toBe(false);
    expect(r.stats).toHaveProperty("unresolvedGaps");
    expect(r.stats).toHaveProperty("tradingDays");
  });

  it("用上海时区判交易日——UTC 前一天的 23:30 在上海已是次日", async () => {
    // 2026-07-30T23:30Z == 2026-07-31 07:30 上海时间，属交易日
    const r = await runJob("preopen", { db, clients: clients(), now: new Date("2026-07-30T23:30:00Z") });
    expect(r.skipped).toBe(false);
  });

  it("未知 job 名抛错", async () => {
    await expect(
      runJob("bogus" as any, { db, clients: clients(), now: new Date() })
    ).rejects.toThrow(/unknown job/i);
  });

  it("intraday 在没有 security 记录时不崩溃", async () => {
    const r = await runJob("intraday", { db, clients: clients(), now: new Date("2026-07-31T03:00:00Z") });
    expect(r.skipped).toBe(false);
    expect(r.stats.snapshotWritten).toBe(0);
  });
});

describe("lhbRefreshDates", () => {
  // 龙虎榜的 D1..D30 标签随时间回填，必须回头重拉。
  // 但"滚动重拉 30 天"= 90 次请求，东财十几次就限流，所以只在标签落地的偏移量上重拉。
  function calendar(days: string[]) {
    const ins = db.prepare(
      "INSERT OR REPLACE INTO trading_calendar (date, is_open, source) VALUES (?, 1, 't')");
    for (const d of days) ins.run(d);
  }
  const seq = (n: number) => Array.from({ length: n }, (_, i) =>
    new Date(Date.parse("2026-08-03T00:00:00Z") - (n - 1 - i) * 86400_000)
      .toISOString().slice(0, 10));

  it("只重拉标签落地的偏移量，不是整段区间", async () => {
    const days = seq(40);
    calendar(days);
    const got = lhbRefreshDates(db, days[0], "2026-08-03");
    // 偏移 0/1/5/10/20/30 —— 六个日期，不是 40 个
    expect(got.length).toBe(LHB_LABEL_OFFSETS.length);
    for (const off of LHB_LABEL_OFFSETS) {
      expect(got).toContain(days[days.length - 1 - off]);
    }
  });

  it("含偏移 0：当日要重拉，龙虎榜是逐步发布的", async () => {
    const days = seq(40);
    calendar(days);
    expect(LHB_LABEL_OFFSETS).toContain(0);
    expect(lhbRefreshDates(db, days[0], "2026-08-03")).toContain("2026-08-03");
  });

  it("历史不够长时只给存在的日期，不造不存在的交易日", async () => {
    const days = seq(3);   // 只有 3 个交易日，偏移 5/10/20/30 都越界
    calendar(days);
    const got = lhbRefreshDates(db, days[0], "2026-08-03");
    expect(got).toEqual([days[1], days[2]]);   // 只剩偏移 1 和 0
    expect(got.every(d => days.includes(d))).toBe(true);
  });

  it("日历为空时返回空，不抛错", () => {
    const empty = openDb(path.join(dir, "empty.db"));
    runMigrations(empty);
    expect(lhbRefreshDates(empty, "2026-01-01", "2026-08-03")).toEqual([]);
    empty.close();
  });
});
