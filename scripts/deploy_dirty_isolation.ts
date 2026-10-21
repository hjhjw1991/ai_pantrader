/**
 * 把 B1 复权脏数据隔离部署到线上账本库。
 *
 * 只调用 lib/ledger/reconcile.ts 里已提交的 markDirtySettled（幂等）：
 * 扫描已结算、未作废、未标脏的 outcome 行，按系统同一套 isDirtyOutcome 判据
 * 重算，命中则降级为「中性」并填上 dirty_reason，保留真实 actual_pct 供人核查。
 * 不碰任何未结算的 10 月推荐行，也不改 prediction / 策略文件。
 *
 * 安全闸：必须确认 dbPath 指向真实的 PanTraderData 线上库，否则拒绝写入。
 */
import { loadCliEnv } from "@/lib/config";
loadCliEnv();
import { getConfig } from "@/lib/config";
import { openDb } from "@/lib/db";
import { markDirtySettled } from "@/lib/ledger/reconcile";

const cfg = getConfig();
const resolved = cfg.dbPath.replace(/\\/g, "/");
console.log("[deploy] dbPath =", resolved);
if (!resolved.endsWith("PanTraderData/data/pantrader.db")) {
  console.error("[deploy] ABORT: dbPath 不是线上账本库，拒绝写入");
  process.exit(3);
}

const db = openDb();
// 二次确认：开库后看实际文件名
const realName = (db as unknown as { name: string }).name ?? resolved;
console.log("[deploy] opened =", realName);

const before = (db.prepare("SELECT COUNT(*) c FROM outcome WHERE dirty_reason IS NOT NULL").get() as { c: number }).c;
const n = markDirtySettled(db, new Date().toISOString());
const after = (db.prepare("SELECT COUNT(*) c FROM outcome WHERE dirty_reason IS NOT NULL").get() as { c: number }).c;

console.log(`[deploy] markDirtySettled 本次标脏 ${n} 行`);
console.log(`[deploy] dirty_reason 非空行: ${before} -> ${after}`);
db.close();
console.log("[deploy] done");
