import { openDb } from "@/lib/db";
import { runMigrations } from "@/lib/db/migrate";
import { createClient } from "@/lib/data/client";
import { fetchAllSecurities } from "@/lib/data/sources/eastmoney";
import { syncCalendar } from "@/lib/data/calendar";

const PAGE_SIZE = 100;

const db = openDb();
runMigrations(db);

// 长任务专用参数：熔断冷却压到 90s，配合 8 轮退避才等得到主机恢复；
// 默认的 5 分钟冷却会让一次性拉取在自己的退避窗口内永远等不到。
const em = createClient("eastmoney", { minIntervalMs: 600, db, cooldownMs: 90_000 });
const sina = createClient("sina", { minIntervalMs: 300, db });

const upsertSec = db.prepare(
  `INSERT INTO security (code, name, board) VALUES (?, ?, ?)
   ON CONFLICT(code) DO UPDATE SET name = excluded.name, board = excluded.board`
);

// 断点续拉：已有 N 只则从第 floor(N/100)+1 页继续。
// --full 强制从第 1 页重来（改了排序或市场过滤器后必须用，旧页码语义已失效）。
const full = process.argv.includes("--full");
const already = (db.prepare("SELECT COUNT(*) n FROM security").get() as any).n as number;
const startPage = full ? 1 : Math.floor(already / PAGE_SIZE) + 1;
if (full) console.log("full refetch requested, starting at page 1");
else if (already > 0) console.log(`resuming: ${already} stored, start at page ${startPage}`);

let securitiesOk = true;
try {
  await fetchAllSecurities(em, {
    startPage,
    rounds: 8,
    backoffMs: 30_000,
    onPage: (page, rows, got, total) => {
      db.transaction(() => { for (const s of rows) upsertSec.run(s.code, s.name, s.board); })();
      const stored = (db.prepare("SELECT COUNT(*) n FROM security").get() as any).n;
      console.log(`  clist page ${page}: +${rows.length} (session ${got}, stored ${stored}/${total})`);
    },
  });
} catch (e: any) {
  securitiesOk = false;
  console.error(`securities incomplete: ${e.message}`);
  console.error("已拉取的部分已落库，重跑本脚本会从断点继续。");
}

const secCount = (db.prepare("SELECT COUNT(*) n FROM security").get() as any).n;
console.log(`securities in db: ${secCount}`);

let calendarOk = true;
try {
  const days = await syncCalendar(db, sina, 1023);
  console.log(`calendar days: ${days}`);
} catch (e: any) {
  calendarOk = false;
  console.error(`calendar failed: ${e.message}`);
}

db.close();
process.exit(securitiesOk && calendarOk ? 0 : 1);
