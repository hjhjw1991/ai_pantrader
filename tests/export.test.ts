import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { openDb } from "@/lib/db";
import { runMigrations } from "@/lib/db/migrate";
import { exportBak } from "@/lib/backup/export";

let dir: string, dbPath: string, db: any;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "pt-"));
  dbPath = path.join(dir, "pantrader.db");
  db = openDb(dbPath);
  runMigrations(db);
  db.prepare("INSERT INTO trading_calendar (date, is_open, source) VALUES ('2026-07-31',1,'t')").run();
  db.prepare("INSERT INTO kline_daily (code, date, c) VALUES ('601012','2026-07-31',13.0)").run();
});
afterEach(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });

describe("exportBak", () => {
  it("生成 .ptbak 文件", async () => {
    const out = path.join(dir, "b.ptbak");
    await exportBak(db, dbPath, out);
    expect(fs.existsSync(out)).toBe(true);
    expect(fs.statSync(out).size).toBeGreaterThan(0);
  });

  it("meta 含表行数与日期范围", async () => {
    const meta = await exportBak(db, dbPath, path.join(dir, "b.ptbak"));
    expect(meta.tableCounts.kline_daily).toBe(1);
    expect(meta.dateFrom).toBe("2026-07-31");
    expect(meta.dateTo).toBe("2026-07-31");
    expect(meta.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(meta.schemaVersion).toBe("1");
  });

  it("包内含 pantrader.db 与 meta.json", async () => {
    const out = path.join(dir, "b.ptbak");
    await exportBak(db, dbPath, out);
    const listing = execSync(`tar -tzf "${out}"`).toString();
    expect(listing).toContain("pantrader.db");
    expect(listing).toContain("meta.json");
  });

  it("导出期间不阻塞后续写入（VACUUM INTO 用副本）", async () => {
    await exportBak(db, dbPath, path.join(dir, "b.ptbak"));
    expect(() => db.prepare(
      "INSERT INTO kline_daily (code, date, c) VALUES ('000001','2026-07-31',11.0)"
    ).run()).not.toThrow();
  });

  it("空库也能导出，日期范围为 null", async () => {
    const p2 = path.join(dir, "empty.db");
    const empty = openDb(p2);
    runMigrations(empty);
    const meta = await exportBak(empty, p2, path.join(dir, "e.ptbak"));
    expect(meta.dateFrom).toBe(null);
    expect(meta.tableCounts.kline_daily).toBe(0);
    empty.close();
  });

  it("输出目录不存在时自动创建", async () => {
    const out = path.join(dir, "nested", "deep", "b.ptbak");
    await exportBak(db, dbPath, out);
    expect(fs.existsSync(out)).toBe(true);
  });
});
