import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb } from "@/lib/db";
import { runMigrations } from "@/lib/db/migrate";
import { detectGaps, coverageReport, recordGap, resolveGap } from "@/lib/data/gap";

let dir: string, db: any;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "pt-"));
  db = openDb(path.join(dir, "t.db"));
  runMigrations(db);
  const cal = db.prepare("INSERT INTO trading_calendar (date, is_open, source) VALUES (?, 1, 't')");
  for (const d of ["2026-07-27", "2026-07-28", "2026-07-29", "2026-07-30", "2026-07-31"]) cal.run(d);
});
afterEach(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });

describe("detectGaps", () => {
  it("找出没有涨停池数据的交易日", () => {
    db.prepare("INSERT INTO zt_pool (date, code, lbc) VALUES ('2026-07-28', '000001', 1)").run();
    const r = detectGaps(db, "2026-07-27", "2026-07-31");
    expect(r.missingZtPool).toEqual(["2026-07-27", "2026-07-29", "2026-07-30", "2026-07-31"]);
  });

  it("找出没有日线数据的交易日", () => {
    db.prepare("INSERT INTO kline_daily (code, date, c) VALUES ('601012', '2026-07-31', 13)").run();
    const r = detectGaps(db, "2026-07-27", "2026-07-31");
    expect(r.missingDaily).toEqual(["2026-07-27", "2026-07-28", "2026-07-29", "2026-07-30"]);
  });

  it("非交易日不算缺口", () => {
    const r = detectGaps(db, "2026-07-27", "2026-08-02");
    expect(r.missingZtPool).not.toContain("2026-08-01");   // 周六
    expect(r.missingZtPool).not.toContain("2026-08-02");   // 周日
  });

  it("日历为空时不报任何缺口", () => {
    const empty = openDb(path.join(dir, "e.db"));
    runMigrations(empty);
    const r = detectGaps(empty, "2026-07-27", "2026-07-31");
    expect(r.missingDaily).toEqual([]);
    empty.close();
  });
});

describe("coverageReport", () => {
  it("统计覆盖率与未解决缺口", () => {
    db.prepare("INSERT INTO zt_pool (date, code, lbc) VALUES ('2026-07-28', '000001', 1)").run();
    recordGap(db, "2026-07-29", "eastmoney", "zt_pool", "blocked", false);
    const r = coverageReport(db, "2026-07-27", "2026-07-31");
    expect(r.tradingDays).toBe(5);
    expect(r.daysWithZtPool).toBe(1);
    expect(r.unresolvedGaps).toBe(1);
  });

  it("已解决的 gap 不计入未解决数", () => {
    recordGap(db, "2026-07-29", "eastmoney", "lhb", "blocked", true);
    resolveGap(db, "2026-07-29", "eastmoney", "lhb");
    const r = coverageReport(db, "2026-07-27", "2026-07-31");
    expect(r.unresolvedGaps).toBe(0);
  });
});
