import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import type { Db } from "@/lib/db";

export const SCHEMA_VERSION = "1";

export interface BakMeta {
  schemaVersion: string;
  createdAt: string;
  dateFrom: string | null;
  dateTo: string | null;
  tableCounts: Record<string, number>;
  sha256: string;
}

export const BAK_TABLES = [
  "kline_daily", "kline_min", "quote_snapshot", "zt_pool", "dt_pool",
  "sector_rank", "lhb", "lhb_seat", "macro", "security", "trading_calendar",
  "data_gap", "source_health",
];

function sha256File(p: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
}

export async function exportBak(db: Db, _dbPath: string, outPath: string): Promise<BakMeta> {
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), "ptbak-"));
  const dbCopy = path.join(stage, "pantrader.db");

  try {
    // VACUUM INTO 产出一致性副本，且不锁住原库的后续写入
    db.prepare("VACUUM INTO ?").run(dbCopy);

    const tableCounts: Record<string, number> = {};
    for (const t of BAK_TABLES) {
      const r = db.prepare(`SELECT COUNT(*) n FROM ${t}`).get() as any;
      tableCounts[t] = r.n;
    }

    const range = db.prepare(
      `SELECT MIN(date) a, MAX(date) b FROM (
         SELECT date FROM kline_daily UNION ALL SELECT date FROM zt_pool
         UNION ALL SELECT date FROM lhb)`
    ).get() as any;

    const meta: BakMeta = {
      schemaVersion: SCHEMA_VERSION,
      createdAt: new Date().toISOString(),
      dateFrom: range?.a ?? null,
      dateTo: range?.b ?? null,
      tableCounts,
      sha256: sha256File(dbCopy),
    };
    fs.writeFileSync(path.join(stage, "meta.json"), JSON.stringify(meta, null, 2));

    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    execFileSync("tar", ["-czf", outPath, "-C", stage, "pantrader.db", "meta.json"]);
    return meta;
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
}
