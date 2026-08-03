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
                     "dt_pool", "sector_rank", "lhb", "lhb_seat", "macro", "security",
                     "trading_calendar", "data_gap", "source_health"]) {
      expect(names).toContain(t);
    }
    db.close();
  });

  it("lhb 主键含 change_type —— 少了它同票多条上榜原因会被折叠", () => {
    const db = openDb(path.join(dir, "t.db"));
    runMigrations(db);
    const pk = db.prepare("PRAGMA table_info(lhb)").all()
      .filter((r: any) => r.pk > 0)
      .sort((a: any, b: any) => a.pk - b.pk)
      .map((r: any) => r.name);
    expect(pk).toEqual(["date", "code", "change_type"]);
    db.close();
  });

  it("每张数据表都在 .ptbak 清单里 —— 漏一张就是备份里静默少一张", async () => {
    const { BAK_TABLES } = await import("@/lib/backup/export");
    const db = openDb(path.join(dir, "t.db"));
    runMigrations(db);
    const names = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
    ).all().map((r: any) => r.name)
      // _migrations 是迁移账本、app_meta 是本机配置，都不属于可搬迁的历史数据
      .filter((n: string) => !n.startsWith("_") && n !== "app_meta");
    for (const t of names) expect(BAK_TABLES).toContain(t);
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
