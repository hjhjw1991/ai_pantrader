import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { openDb } from "@/lib/db";
import { runMigrations } from "@/lib/db/migrate";
import { exportBak } from "@/lib/backup/export";
import { importBak } from "@/lib/backup/import";

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "pt-")); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

function seed(p: string, rows: Array<[string, string, number]>) {
  const db = openDb(p);
  runMigrations(db);
  const s = db.prepare("INSERT OR REPLACE INTO kline_daily (code,date,c) VALUES (?,?,?)");
  for (const r of rows) s.run(...r);
  return db;
}

async function makeBak(rows: Array<[string, string, number]>, bakName = "a.ptbak") {
  const srcPath = path.join(dir, `src-${bakName}.db`);
  const src = seed(srcPath, rows);
  const bak = path.join(dir, bakName);
  const meta = await exportBak(src, srcPath, bak);
  src.close();
  return { bak, meta };
}

describe("importBak", () => {
  it("replace 模式：空目录导入后行数与导出时一致", async () => {
    const { bak, meta } = await makeBak([["601012", "2026-07-30", 13], ["601012", "2026-07-31", 14]]);
    const dstPath = path.join(dir, "empty", "pantrader.db");

    const rep = await importBak(bak, dstPath, { mode: "replace" });
    expect(rep.applied).toBe(true);

    const dst = openDb(dstPath);
    const n = dst.prepare("SELECT COUNT(*) n FROM kline_daily").get() as any;
    expect(n.n).toBe(meta.tableCounts.kline_daily);
    dst.close();
  });

  it("replace 模式会先备份既有库", async () => {
    const { bak } = await makeBak([["601012", "2026-07-31", 14]]);
    const dstPath = path.join(dir, "dst.db");
    seed(dstPath, [["000001", "2026-07-31", 11]]).close();

    await importBak(bak, dstPath, { mode: "replace" });
    const backups = fs.readdirSync(dir).filter(f => f.includes("dst.db.bak-"));
    expect(backups.length).toBe(1);
  });

  it("dry-run 不落盘，只报告", async () => {
    const { bak } = await makeBak([["601012", "2026-07-31", 14]]);
    const dstPath = path.join(dir, "dst.db");
    seed(dstPath, []).close();

    const rep = await importBak(bak, dstPath, { mode: "dry-run" });
    expect(rep.applied).toBe(false);
    expect(rep.changes.kline_daily.inserted).toBe(1);

    const check = openDb(dstPath);
    const n = check.prepare("SELECT COUNT(*) n FROM kline_daily").get() as any;
    expect(n.n).toBe(0);
    check.close();
  });

  it("merge 模式：并集去重，本地已有行不丢", async () => {
    const { bak } = await makeBak([["601012", "2026-07-31", 14]]);
    const dstPath = path.join(dir, "dst.db");
    seed(dstPath, [["000001", "2026-07-31", 11]]).close();

    await importBak(bak, dstPath, { mode: "merge", prefer: "incoming" });
    const check = openDb(dstPath);
    const codes = check.prepare("SELECT code FROM kline_daily ORDER BY code")
      .all().map((r: any) => r.code);
    expect(codes).toEqual(["000001", "601012"]);
    check.close();
  });

  it("merge + prefer:incoming 时冲突行取导入值", async () => {
    const { bak } = await makeBak([["601012", "2026-07-31", 99]]);
    const dstPath = path.join(dir, "dst.db");
    seed(dstPath, [["601012", "2026-07-31", 14]]).close();

    await importBak(bak, dstPath, { mode: "merge", prefer: "incoming" });
    const check = openDb(dstPath);
    const row = check.prepare("SELECT c FROM kline_daily WHERE code='601012'").get() as any;
    expect(row.c).toBe(99);
    check.close();
  });

  it("merge + prefer:local 时冲突行保留本地值", async () => {
    const { bak } = await makeBak([["601012", "2026-07-31", 99]]);
    const dstPath = path.join(dir, "dst.db");
    seed(dstPath, [["601012", "2026-07-31", 14]]).close();

    await importBak(bak, dstPath, { mode: "merge", prefer: "local" });
    const check = openDb(dstPath);
    const row = check.prepare("SELECT c FROM kline_daily WHERE code='601012'").get() as any;
    expect(row.c).toBe(14);
    check.close();
  });

  it("校验和不匹配时拒绝导入", async () => {
    const { bak } = await makeBak([["601012", "2026-07-31", 14]]);

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tamper-"));
    execFileSync("tar", ["-xzf", bak, "-C", tmp]);
    fs.appendFileSync(path.join(tmp, "pantrader.db"), "corrupt");
    execFileSync("tar", ["-czf", bak, "-C", tmp, "pantrader.db", "meta.json"]);
    fs.rmSync(tmp, { recursive: true, force: true });

    await expect(
      importBak(bak, path.join(dir, "x.db"), { mode: "replace" })
    ).rejects.toThrow(/checksum/i);
  });

  it("schema 版本不符时拒绝导入", async () => {
    const { bak } = await makeBak([["601012", "2026-07-31", 14]]);

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ver-"));
    execFileSync("tar", ["-xzf", bak, "-C", tmp]);
    const metaPath = path.join(tmp, "meta.json");
    const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
    meta.schemaVersion = "999";
    fs.writeFileSync(metaPath, JSON.stringify(meta));
    execFileSync("tar", ["-czf", bak, "-C", tmp, "pantrader.db", "meta.json"]);
    fs.rmSync(tmp, { recursive: true, force: true });

    await expect(
      importBak(bak, path.join(dir, "x.db"), { mode: "replace" })
    ).rejects.toThrow(/schema version/i);
  });

  it("merge 覆盖所有表，不只是 kline_daily", async () => {
    const srcPath = path.join(dir, "multi.db");
    const src = openDb(srcPath);
    runMigrations(src);
    src.prepare("INSERT INTO security (code, name, board) VALUES ('601012','隆基','主板')").run();
    src.prepare("INSERT INTO zt_pool (date, code, lbc) VALUES ('2026-07-31','000593',1)").run();
    src.prepare("INSERT INTO lhb (date, code) VALUES ('2026-07-31','601012')").run();
    const bak = path.join(dir, "multi.ptbak");
    await exportBak(src, srcPath, bak);
    src.close();

    const dstPath = path.join(dir, "dstmulti.db");
    seed(dstPath, []).close();
    await importBak(bak, dstPath, { mode: "merge" });

    const check = openDb(dstPath);
    expect((check.prepare("SELECT COUNT(*) n FROM security").get() as any).n).toBe(1);
    expect((check.prepare("SELECT COUNT(*) n FROM zt_pool").get() as any).n).toBe(1);
    expect((check.prepare("SELECT COUNT(*) n FROM lhb").get() as any).n).toBe(1);
    check.close();
  });
});
