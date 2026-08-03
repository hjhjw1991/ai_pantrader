import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb } from "@/lib/db";
import { runMigrations } from "@/lib/db/migrate";

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "pt-")); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

describe("db", () => {
  it("openDb 创建文件并启用 WAL", () => {
    const db = openDb(path.join(dir, "t.db"));
    expect(db.pragma("journal_mode", { simple: true })).toBe("wal");
    db.close();
  });

  it("runMigrations 建出全部 M0 表", () => {
    const db = openDb(path.join(dir, "t.db"));
    runMigrations(db);
    const names = db.prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all().map((r: any) => r.name);
    for (const t of ["kline_daily", "kline_min", "quote_snapshot", "zt_pool",
                     "dt_pool", "sector_rank", "lhb", "macro", "security",
                     "trading_calendar", "data_gap", "source_health"]) {
      expect(names).toContain(t);
    }
    db.close();
  });

  it("runMigrations 幂等，二次执行不重复应用", () => {
    const db = openDb(path.join(dir, "t.db"));
    const first = runMigrations(db);
    const second = runMigrations(db);
    expect(first.length).toBeGreaterThan(0);
    expect(second.length).toBe(0);
    db.close();
  });
});
