import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb } from "@/lib/db";
import { runMigrations } from "@/lib/db/migrate";
import { getMeta, setMeta, systemStartDate } from "@/lib/data/meta";
import { runJob } from "@/lib/data/jobs";

let dir: string, db: any;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "pt-"));
  db = openDb(path.join(dir, "t.db"));
  runMigrations(db);
});
afterEach(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });

describe("app_meta", () => {
  it("读写键值", () => {
    expect(getMeta(db, "nope")).toBe(null);
    setMeta(db, "k", "v1");
    expect(getMeta(db, "k")).toBe("v1");
    setMeta(db, "k", "v2");
    expect(getMeta(db, "k")).toBe("v2");
  });

  it("systemStartDate 首次写入并固化，之后不随日期变化", () => {
    expect(systemStartDate(db, "2026-08-03")).toBe("2026-08-03");
    expect(systemStartDate(db, "2026-09-01")).toBe("2026-08-03");
  });
});

describe("selfcheck 的缺口起算点", () => {
  it("不把系统上线前的历史算成缺口", async () => {
    // 日历有 2022 年起的交易日，但系统今天才上线
    const cal = db.prepare("INSERT INTO trading_calendar (date, is_open, source) VALUES (?, 1, 't')");
    for (const d of ["2022-05-17", "2024-01-02", "2026-07-30", "2026-07-31"]) cal.run(d);

    const clients = {
      sina: {} as any, tencent: {} as any, eastmoney: {} as any,
    };
    const r = await runJob("selfcheck", { db, clients, now: new Date("2026-07-31T02:00:00Z") });

    expect(r.since).toBe("2026-07-31");
    // 只有 2026-07-31 这一天在统计范围内，不是全部 4 天
    expect(r.stats.tradingDays).toBe(1);
    expect(r.stats.missingDailyDays).toBe(1);
  });
});
