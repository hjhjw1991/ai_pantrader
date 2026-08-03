import { openDb } from "@/lib/db";
import { runMigrations } from "@/lib/db/migrate";
import { createClient } from "@/lib/data/client";
import { fetchAllSecurities } from "@/lib/data/sources/eastmoney";
import { syncCalendar } from "@/lib/data/calendar";

const db = openDb();
runMigrations(db);

const em = createClient("eastmoney", { minIntervalMs: 500, db });
const sina = createClient("sina", { minIntervalMs: 300, db });

const secs = await fetchAllSecurities(em, {
  rounds: 5,
  backoffMs: 20_000,
  onPage: (page, got, total) => console.log(`  clist page ${page}: ${got}/${total}`),
});
const stmt = db.prepare(
  `INSERT INTO security (code, name, board) VALUES (?, ?, ?)
   ON CONFLICT(code) DO UPDATE SET name = excluded.name, board = excluded.board`
);
db.transaction(() => { for (const s of secs) stmt.run(s.code, s.name, s.board); })();
console.log(`securities: ${secs.length}`);

const days = await syncCalendar(db, sina, 1023);
console.log(`calendar days: ${days}`);

db.close();
