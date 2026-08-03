import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { openDb } from "@/lib/db";
import { runMigrations } from "@/lib/db/migrate";
import { SCHEMA_VERSION, type BakMeta } from "@/lib/backup/export";

export type ImportMode = "replace" | "merge" | "dry-run";
export type Prefer = "newer" | "local" | "incoming";

export interface ImportReport {
  mode: ImportMode;
  meta: BakMeta;
  changes: Record<string, { inserted: number; updated: number; skipped: number }>;
  applied: boolean;
}

const TABLES: Array<{ name: string; pk: string[] }> = [
  { name: "kline_daily",      pk: ["code", "date"] },
  { name: "kline_min",        pk: ["code", "ts", "period"] },
  { name: "quote_snapshot",   pk: ["ts", "code"] },
  { name: "zt_pool",          pk: ["date", "code"] },
  { name: "dt_pool",          pk: ["date", "code"] },
  { name: "sector_rank",      pk: ["date", "ts", "sector"] },
  { name: "lhb",              pk: ["date", "code"] },
  { name: "macro",            pk: ["ts", "symbol"] },
  { name: "security",         pk: ["code"] },
  { name: "trading_calendar", pk: ["date"] },
  { name: "data_gap",         pk: ["date", "source", "kind"] },
  { name: "source_health",    pk: ["source", "ts"] },
];

function unpack(bakPath: string): { stage: string; dbFile: string; meta: BakMeta } {
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), "ptimp-"));
  execFileSync("tar", ["-xzf", bakPath, "-C", stage]);
  const dbFile = path.join(stage, "pantrader.db");
  const meta: BakMeta = JSON.parse(fs.readFileSync(path.join(stage, "meta.json"), "utf8"));

  const actual = crypto.createHash("sha256").update(fs.readFileSync(dbFile)).digest("hex");
  if (actual !== meta.sha256) {
    fs.rmSync(stage, { recursive: true, force: true });
    throw new Error(`checksum mismatch: expected ${meta.sha256}, got ${actual}`);
  }
  if (meta.schemaVersion !== SCHEMA_VERSION) {
    fs.rmSync(stage, { recursive: true, force: true });
    throw new Error(
      `schema version mismatch: bak=${meta.schemaVersion} current=${SCHEMA_VERSION}`
    );
  }
  return { stage, dbFile, meta };
}

/**
 * prefer 语义：
 *   incoming — 冲突行取导入包的值（默认；复权因子这类会被上游修正的字段应取新的）
 *   local    — 冲突行保留本地值
 *   newer    — M0 等同 incoming。表内尚无统一的行级时间戳可比较，
 *              M1 引入 updated_at 列后再实现真正的按时间取新。
 */
export async function importBak(
  bakPath: string, targetDbPath: string, o: { mode: ImportMode; prefer?: Prefer }
): Promise<ImportReport> {
  const { stage, dbFile, meta } = unpack(bakPath);
  const prefer = o.prefer ?? "incoming";
  const changes: ImportReport["changes"] = {};

  try {
    if (o.mode === "replace") {
      fs.mkdirSync(path.dirname(targetDbPath), { recursive: true });
      if (fs.existsSync(targetDbPath)) {
        fs.copyFileSync(targetDbPath, `${targetDbPath}.bak-${Date.now()}`);
      }
      for (const suffix of ["", "-wal", "-shm"]) {
        const p = targetDbPath + suffix;
        if (fs.existsSync(p)) fs.rmSync(p);
      }
      fs.copyFileSync(dbFile, targetDbPath);
      for (const t of TABLES) {
        changes[t.name] = { inserted: meta.tableCounts[t.name] ?? 0, updated: 0, skipped: 0 };
      }
      return { mode: o.mode, meta, changes, applied: true };
    }

    // merge / dry-run
    const db = openDb(targetDbPath);
    runMigrations(db);
    db.exec(`ATTACH DATABASE '${dbFile.replace(/'/g, "''")}' AS inc`);

    try {
      for (const t of TABLES) {
        const cols = db.prepare(`PRAGMA table_info(${t.name})`)
          .all().map((r: any) => r.name as string);
        const colList = cols.join(", ");
        const on = t.pk.map(k => `main.${t.name}.${k} = inc.${t.name}.${k}`).join(" AND ");

        const ins = db.prepare(
          `SELECT COUNT(*) n FROM inc.${t.name}
           WHERE NOT EXISTS (SELECT 1 FROM main.${t.name} WHERE ${on})`
        ).get() as any;
        const dup = db.prepare(
          `SELECT COUNT(*) n FROM inc.${t.name}
           WHERE EXISTS (SELECT 1 FROM main.${t.name} WHERE ${on})`
        ).get() as any;

        changes[t.name] = {
          inserted: ins.n,
          updated: prefer === "local" ? 0 : dup.n,
          skipped: prefer === "local" ? dup.n : 0,
        };

        if (o.mode === "merge") {
          const verb = prefer === "local" ? "INSERT OR IGNORE" : "INSERT OR REPLACE";
          db.exec(`${verb} INTO main.${t.name} (${colList}) SELECT ${colList} FROM inc.${t.name}`);
        }
      }
    } finally {
      db.exec("DETACH DATABASE inc");
      db.close();
    }
    return { mode: o.mode, meta, changes, applied: o.mode === "merge" };
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
}
