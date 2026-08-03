import { openDb } from "@/lib/db";
import { runMigrations } from "@/lib/db/migrate";

const db = openDb();
const applied = runMigrations(db);
console.log(applied.length ? `applied: ${applied.join(", ")}` : "already up to date");
db.close();
