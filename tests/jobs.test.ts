import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb } from "@/lib/db";
import { runMigrations } from "@/lib/db/migrate";
import { runJob } from "@/lib/data/jobs";

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
