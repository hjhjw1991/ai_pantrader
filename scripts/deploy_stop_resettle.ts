/**
 * 把 P3「破止损按止损价离场」的口径部署到线上账本库。
 *
 * 只调用 lib/ledger/reconcile.ts 里已提交的 resettleStoppedOut（幂等）：
 * 扫描已结算、未作废、未标脏、且真成交过的 outcome 行，用同一套 settleOne 重算，
 * 命中止损的行改为按止损口径离场。跑第二遍应当返回 0。
 *
 * 安全闸：必须确认 dbPath 指向真实的 PanTraderData 线上库，否则拒绝写入。
 */
import { loadCliEnv } from "@/lib/config";
loadCliEnv();
import { getConfig } from "@/lib/config";
import { openDb } from "@/lib/db";
import { resettleStoppedOut } from "@/lib/ledger/reconcile";

const cfg = getConfig();
const resolved = cfg.dbPath.replace(/\\/g, "/");
console.log("[deploy] dbPath =", resolved);
if (!resolved.endsWith("PanTraderData/data/pantrader.db")) {
  console.error("[deploy] ABORT: dbPath 不是线上账本库，拒绝写入");
  process.exit(3);
}

const db = openDb();
console.log("[deploy] opened =", (db as unknown as { name: string }).name ?? resolved);

const rows = db.prepare(
  `SELECT p.id, p.code, p.action, p.eval_horizon, p.stop_px,
          o.verdict, o.actual_pct, o.mae_pct, o.entry_px, o.entry_date
   FROM prediction p JOIN outcome o ON o.pred_id = p.id
   WHERE o.verdict != '作废' AND o.dirty_reason IS NULL AND o.entry_px IS NOT NULL
   ORDER BY p.id`
).all() as Array<{
  id: string; code: string; action: string; eval_horizon: number; stop_px: number | null;
  verdict: string; actual_pct: number | null; mae_pct: number | null;
  entry_px: number; entry_date: string;
}>;
console.log(`[deploy] 候选（已成交、非脏非作废）${rows.length} 行`);

const n = resettleStoppedOut(db, new Date().toISOString());
console.log(`[deploy] resettleStoppedOut 本次重结 ${n} 行`);

for (const r of rows) {
  const now = db.prepare(
    "SELECT verdict, actual_pct, mae_pct, error_type FROM outcome WHERE pred_id = ?"
  ).get(r.id) as { verdict: string; actual_pct: number | null; mae_pct: number | null; error_type: string | null };
  if (now.actual_pct == null || r.actual_pct == null) continue;
  if (Math.abs(now.actual_pct - r.actual_pct) < 1e-9) continue;
  console.log(
    `  ${r.id} ${r.action} stop=${r.stop_px} entry=${r.entry_px}@${r.entry_date}` +
    ` | actual ${r.actual_pct.toFixed(2)}% -> ${now.actual_pct.toFixed(2)}%` +
    ` | mae ${r.mae_pct?.toFixed(2) ?? "-"} -> ${now.mae_pct?.toFixed(2) ?? "-"}` +
    ` | ${r.verdict} -> ${now.verdict} | 新错因 ${now.error_type ?? "（待 attributeSettled 补）"}`
  );
}

// 幂等复核
const again = resettleStoppedOut(db, new Date().toISOString());
console.log(`[deploy] 幂等复核：第二遍重结 ${again} 行（应为 0）`);
db.close();
console.log("[deploy] done");
