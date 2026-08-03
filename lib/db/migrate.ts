import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Db } from "@/lib/db";

const MIG_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "migrations");

export function runMigrations(db: Db): string[] {
  db.exec(`CREATE TABLE IF NOT EXISTS _migrations (
    name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)`);

  const applied = new Set(
    db.prepare("SELECT name FROM _migrations").all().map((r: any) => r.name)
  );
  const files = fs.readdirSync(MIG_DIR).filter(f => f.endsWith(".sql")).sort();
  const done: string[] = [];

  for (const f of files) {
    if (applied.has(f)) continue;
    const sql = fs.readFileSync(path.join(MIG_DIR, f), "utf8");
    db.transaction(() => {
      db.exec(sql);
      db.prepare("INSERT INTO _migrations (name, applied_at) VALUES (?, ?)")
        .run(f, new Date().toISOString());
    })();
    done.push(f);
  }
  return done;
}
