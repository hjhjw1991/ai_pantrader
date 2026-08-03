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

interface TableSpec {
  name: string;
  /** 行身份。必须与建表主键完全一致，少一列就会在 merge 时把不同的行合成一行。 */
  pk: string[];
  /**
   * batch-replace：表没有可跨库比对的行主键（lhb_seat 用的是自增 id，
   * 两个库的 id 互相冲突），只能按批次整体替换。pk 在此语义下是批次键。
   */
  strategy?: "batch-replace";
  /** batch-replace 时不搬运的列（自增主键由目标库自己生成） */
  omitCols?: string[];
}

const TABLES: TableSpec[] = [
  { name: "kline_daily",      pk: ["code", "date"] },
  { name: "kline_min",        pk: ["code", "ts", "period"] },
  { name: "quote_snapshot",   pk: ["ts", "code"] },
  { name: "zt_pool",          pk: ["date", "code"] },
  { name: "dt_pool",          pk: ["date", "code"] },
  { name: "sector_rank",      pk: ["date", "ts", "sector"] },
  // change_type 是行身份的一部分：少了它，同一只票同一天的多条上榜原因会被合成一条
  { name: "lhb",              pk: ["date", "code", "change_type"] },
  { name: "lhb_seat",         pk: ["date", "side"], strategy: "batch-replace", omitCols: ["id"] },
  { name: "macro",            pk: ["ts", "symbol"] },
  { name: "security",         pk: ["code"] },
  { name: "trading_calendar", pk: ["date"] },
  { name: "data_gap",         pk: ["date", "source", "kind"] },
  { name: "source_health",    pk: ["source", "ts"] },
  { name: "strategy",         pk: ["id", "version"] },
  { name: "watchpool",        pk: ["code"] },
  { name: "prediction",       pk: ["id"] },
  { name: "outcome",          pk: ["pred_id"] },
  { name: "advisor_output",   pk: ["ts", "code", "slot"] },
  { name: "account",          pk: ["id"] },
  { name: "position",         pk: ["account_id", "code"] },
  { name: "trade",            pk: ["id"] },
  { name: "ord",              pk: ["id"] },
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
        const allCols = db.prepare(`PRAGMA table_info(${t.name})`)
          .all().map((r: any) => r.name as string);
        const cols = allCols.filter(c => !(t.omitCols ?? []).includes(c));
        const colList = cols.join(", ");
        const on = t.pk.map(k => `main.${t.name}.${k} = inc.${t.name}.${k}`).join(" AND ");

        if (t.strategy === "batch-replace") {
          const batches = db.prepare(
            `SELECT DISTINCT ${t.pk.join(", ")} FROM inc.${t.name}`
          ).all() as any[];
          const where = t.pk.map(k => `${k} = ?`).join(" AND ");
          const vals = (b: any) => t.pk.map(k => b[k]);

          let incoming = 0, clobbered = 0;
          for (const b of batches) {
            const inc = db.prepare(
              `SELECT COUNT(*) n FROM inc.${t.name} WHERE ${where}`).get(...vals(b)) as any;
            const loc = db.prepare(
              `SELECT COUNT(*) n FROM main.${t.name} WHERE ${where}`).get(...vals(b)) as any;
            incoming += inc.n;
            clobbered += loc.n;
          }
          // 批次已存在时：prefer=local 整批不动，否则整批替换
          const keepLocal = prefer === "local";
          changes[t.name] = {
            inserted: keepLocal ? incoming - clobbered : incoming,
            updated: keepLocal ? 0 : clobbered,
            skipped: keepLocal ? clobbered : 0,
          };

          if (o.mode === "merge") {
            for (const b of batches) {
              const has = (db.prepare(
                `SELECT COUNT(*) n FROM main.${t.name} WHERE ${where}`).get(...vals(b)) as any).n;
              if (has && keepLocal) continue;
              db.prepare(`DELETE FROM main.${t.name} WHERE ${where}`).run(...vals(b));
              db.prepare(
                `INSERT INTO main.${t.name} (${colList})
                 SELECT ${colList} FROM inc.${t.name} WHERE ${where}`
              ).run(...vals(b));
            }
          }
          continue;
        }

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
