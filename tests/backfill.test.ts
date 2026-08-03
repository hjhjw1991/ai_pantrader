import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb } from "@/lib/db";
import { runMigrations } from "@/lib/db/migrate";
import { recordGap } from "@/lib/data/gap";
import { backfillRecoverable } from "@/lib/data/backfill";

let dir: string, db: any;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "pt-"));
  db = openDb(path.join(dir, "t.db"));
  runMigrations(db);
  const cal = db.prepare("INSERT INTO trading_calendar (date, is_open, source) VALUES (?, 1, 't')");
  for (const d of ["2026-07-29", "2026-07-30", "2026-07-31"]) cal.run(d);
});
afterEach(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });

const lhbPayload = JSON.stringify({
  result: {
    pages: 1,
    data: [{
      SECURITY_CODE: "601012", SECURITY_NAME_ABBR: "隆基绿能",
      BILLBOARD_NET_AMT: 100, BILLBOARD_BUY_AMT: 200, BILLBOARD_SELL_AMT: 100,
      EXPLAIN: "机构专用", D1_CLOSE_ADJCHRATE: 1.2,
      D5_CLOSE_ADJCHRATE: null, D10_CLOSE_ADJCHRATE: null,
    }],
  },
});

const okClient = {
  source: "eastmoney",
  breaker: { isOpen: () => false, record() {}, reset() {} } as any,
  async get() { return { ok: true as const, text: lhbPayload, status: 200, latencyMs: 3 }; },
};

const failClient = {
  source: "eastmoney",
  breaker: { isOpen: () => false, record() {}, reset() {} } as any,
  async get() { return { ok: false as const, error: "empty response body", latencyMs: 3 }; },
};

describe("backfillRecoverable", () => {
  it("补齐缺失的龙虎榜交易日并落库", async () => {
    const r = await backfillRecoverable(db, okClient as any, "2026-07-29", "2026-07-31");
    expect(r.attempted).toEqual(["2026-07-29", "2026-07-30", "2026-07-31"]);
    expect(r.recovered.length).toBe(3);
    const n = db.prepare("SELECT COUNT(DISTINCT date) n FROM lhb").get() as any;
    expect(n.n).toBe(3);
  });

  it("已有数据的日期不重复回补", async () => {
    db.prepare("INSERT INTO lhb (date, code) VALUES ('2026-07-30', '000001')").run();
    const r = await backfillRecoverable(db, okClient as any, "2026-07-29", "2026-07-31");
    expect(r.attempted).toEqual(["2026-07-29", "2026-07-31"]);
  });

  it("回补失败记录到 failed，不中断其余日期", async () => {
    const r = await backfillRecoverable(db, failClient as any, "2026-07-29", "2026-07-31");
    expect(r.recovered.length).toBe(0);
    expect(r.failed.length).toBe(3);
    expect(r.failed[0].error).toMatch(/lhb/i);
  });

  it("统计不可回补的未解决缺口数量", async () => {
    recordGap(db, "2026-07-30", "tencent", "quote_snapshot", "machine asleep", false);
    const r = await backfillRecoverable(db, okClient as any, "2026-07-29", "2026-07-31");
    expect(r.unrecoverable).toBe(1);
  });

  it("maxDays 限制单次回补量，避免一次打爆限频", async () => {
    const r = await backfillRecoverable(db, okClient as any, "2026-07-29", "2026-07-31", { maxDays: 2 });
    expect(r.attempted.length).toBe(2);
  });
});
