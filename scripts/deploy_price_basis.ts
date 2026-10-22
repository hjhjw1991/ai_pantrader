/**
 * 把「成交价与离场价统一到后复权基准」的口径部署到线上账本库。
 *
 * 只调用 lib/ledger/reconcile.ts 里已提交的 resettlePriceBasis（幂等）：
 * 扫描已结算、未作废的 outcome 行（**含已标脏的**），用同一套 settleOne 重算，
 * 把入场价/出场价/止损价/MFE-MAE 全部换到后复权基准。跑第二遍应当返回 0。
 *
 * 与标脏补丁的区别要说清楚：标脏是把错的数藏起来（不进分母），
 * 这一遍是把错的数改对 —— 原来被 DIRTY_CAP 隔离的那批，重结后回到正常量级，
 * dirty_reason 自动解除，样本重新回到统计里。
 *
 * 安全闸：必须确认 dbPath 指向真实的 PanTraderData 线上库，否则拒绝写入。
 */
import { loadCliEnv } from "@/lib/config";
loadCliEnv();
import { getConfig } from "@/lib/config";
import { openDb } from "@/lib/db";
import { resettlePriceBasis } from "@/lib/ledger/reconcile";

const cfg = getConfig();
const resolved = cfg.dbPath.replace(/\\/g, "/");
console.log("[deploy] dbPath =", resolved);
if (!resolved.endsWith("PanTraderData/data/pantrader.db")) {
  console.error("[deploy] ABORT: dbPath 不是线上账本库，拒绝写入");
  process.exit(3);
}

const db = openDb();
console.log("[deploy] opened =", (db as unknown as { name: string }).name ?? resolved);

const before = db.prepare(
  `SELECT p.id, p.code, p.action, p.eval_horizon, p.trigger_px,
          o.verdict, o.actual_pct, o.entry_px, o.entry_date, o.dirty_reason
   FROM prediction p JOIN outcome o ON o.pred_id = p.id
   WHERE o.verdict != '作废'
   ORDER BY p.id`
).all() as Array<{
  id: string; code: string; action: string; eval_horizon: number; trigger_px: number | null;
  verdict: string; actual_pct: number | null; entry_px: number | null;
  entry_date: string | null; dirty_reason: string | null;
}>;
const dirtyBefore = before.filter(r => r.dirty_reason != null).length;
console.log(`[deploy] 候选（已结算且未作废）${before.length} 行，其中已标脏 ${dirtyBefore} 行`);

const n = resettlePriceBasis(db, new Date().toISOString());
console.log(`[deploy] resettlePriceBasis 本次重结 ${n} 行`);

let recovered = 0;
for (const r of before) {
  const now = db.prepare(
    "SELECT verdict, actual_pct, entry_px, dirty_reason FROM outcome WHERE pred_id = ?"
  ).get(r.id) as
    | { verdict: string; actual_pct: number | null; entry_px: number | null; dirty_reason: string | null }
    | undefined;
  if (!now) continue;
  const changed = r.actual_pct == null || now.actual_pct == null
    ? r.actual_pct !== now.actual_pct
    : Math.abs(now.actual_pct - r.actual_pct) > 1e-9;
  if (!changed && (r.dirty_reason ?? null) === (now.dirty_reason ?? null)) continue;

  const wasDirty = r.dirty_reason != null && now.dirty_reason == null;
  if (wasDirty) recovered++;
  console.log(
    `  ${r.id} ${r.code} ${r.action} D${r.eval_horizon}` +
    ` | entry ${r.entry_px?.toFixed(2) ?? "-"} -> ${now.entry_px?.toFixed(2) ?? "-"}` +
    ` | actual ${r.actual_pct?.toFixed(2) ?? "-"}% -> ${now.actual_pct?.toFixed(2) ?? "-"}%` +
    ` | ${r.verdict} -> ${now.verdict}` +
    (wasDirty ? " | ✅ 脏标记解除，样本回到统计" : "") +
    ((r.dirty_reason == null && now.dirty_reason != null) ? " | ⚠ 新标脏" : "")
  );
}
console.log(`[deploy] 脏标记解除 ${recovered} 行`);

const after = db.prepare(
  "SELECT COUNT(*) n FROM outcome o WHERE o.verdict != '作废' AND o.dirty_reason IS NOT NULL"
).get() as { n: number };
console.log(`[deploy] 剩余脏行 ${after.n} 行（原 ${dirtyBefore} 行）`);

// 幂等复核
const again = resettlePriceBasis(db, new Date().toISOString());
console.log(`[deploy] 幂等复核：第二遍重结 ${again} 行（应为 0）`);
db.close();
console.log("[deploy] done");
