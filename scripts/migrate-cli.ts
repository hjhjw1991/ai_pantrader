import { openDb } from "@/lib/db";
import { runMigrations } from "@/lib/db/migrate";
// CLI 不读 .env.local（只有 next 会读），这里补上，免得在默认目录上新建/操作一个空库
import { loadCliEnv } from "@/lib/config";
loadCliEnv();

const db = openDb();
const applied = runMigrations(db);
console.log(applied.length ? `applied: ${applied.join(", ")}` : "already up to date");
db.close();
