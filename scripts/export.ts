import path from "node:path";
import { openDb } from "@/lib/db";
import { runMigrations } from "@/lib/db/migrate";
import { getConfig } from "@/lib/config";
import { exportBak } from "@/lib/backup/export";
// CLI 不读 .env.local（只有 next 会读），这里补上，免得在默认目录上新建/操作一个空库
import { loadCliEnv } from "@/lib/config";
loadCliEnv();

const cfg = getConfig();
const stamp = new Date().toISOString().slice(0, 10);
const out = process.argv[2] ?? path.join(cfg.dataDir, `pantrader-${stamp}.ptbak`);

const db = openDb();
runMigrations(db);
const meta = await exportBak(db, cfg.dbPath, out);
db.close();

console.log(`exported -> ${out}`);
console.log(JSON.stringify(meta, null, 2));
