import { openDb } from "@/lib/db";
import { runMigrations } from "@/lib/db/migrate";
import { createClient } from "@/lib/data/client";
import { runJob, type JobName } from "@/lib/data/jobs";

const name = process.argv[2] as JobName;
if (!name) {
  console.error("usage: pnpm job <selfcheck|preopen|intraday|close|post|night>");
  process.exit(2);
}

const db = openDb();
runMigrations(db);

const clients = {
  sina: createClient("sina", { minIntervalMs: 300, db }),
  tencent: createClient("tencent", { minIntervalMs: 300, db }),
  eastmoney: createClient("eastmoney", { minIntervalMs: 500, db }),
};

try {
  const r = await runJob(name, { db, clients, now: new Date() });
  console.log(JSON.stringify(r));
  db.close();
  process.exit(0);
} catch (e: any) {
  console.error(JSON.stringify({ name, error: e?.message ?? String(e) }));
  db.close();
  process.exit(1);
}
