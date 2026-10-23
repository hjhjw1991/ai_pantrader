/**
 * 把「时间止损」口径部署到线上账本库：已结算的历史行按新持仓期重结。
 *
 * 为什么必须重结一遍（而不是只让新信号用新口径）：
 * 台账的核心指标是「带纪律执行的期望收益」。老行是按"一路拿到期满"算的，
 * 新行按"持仓满 1 个交易日了结"算 —— 两个数混在同一个胜率、同一个期望里，
 * 那个数既不描述旧策略也不描述新策略。这与 B3 止损口径重结是同一个道理：
 * 留着旧数，指标从第一天起就是假的。
 *
 * 只调用 lib/ledger/reconcile.ts 里已提交的 resettlePriceBasis（幂等），
 * 不传 maxHoldDays 即跟随 DEFAULT_MAX_HOLD_DAYS。跑第二遍应当返回 0。
 *
 * 会改什么：verdict / actual_pct / mfe_pct / mae_pct / entry_px / entry_date /
 * dirty_reason，并把 error_type 清空（错因是对着旧事实归的，事实变了旧解释就该丢掉，
 * 随后由 attributeSettled 补回来）。
 *
 * 不改什么：**prediction 表不动**。止盈价是当时落库时按当时默认值算出来的
 * （老行 5%，新行 8%），它是历史快照，不为了口径好看去改写它。
 * 代价是历史行重结后是"持仓 1 天 + 止盈 5%"，新行是"持仓 1 天 + 止盈 8%"。
 * 两者在扫描里差 0.022pp（0.200% vs 0.222%），这个不一致性如实记在报告里，
 * 好过为了对齐去伪造一条没挂过的单。
 *
 * 安全闸：必须确认 dbPath 指向真实的 PanTraderData 线上库，否则拒绝写入。
 * 写前先把 prediction / outcome 两张表另存一份小副本（整库 4GB 不值得复制，
 * 本次只动这两张表）。
 */
import { loadCliEnv } from "@/lib/config";
loadCliEnv();
import fs from "node:fs";
import path from "node:path";
import { getConfig } from "@/lib/config";
import { openDb } from "@/lib/db";
import { resettlePriceBasis, DEFAULT_MAX_HOLD_DAYS } from "@/lib/ledger/reconcile";

const cfg = getConfig();
const resolved = cfg.dbPath.replace(/\\/g, "/");
console.log("[deploy] dbPath =", resolved);
if (!resolved.endsWith("PanTraderData/data/pantrader.db")) {
  console.error("[deploy] ABORT: dbPath 不是线上账本库，拒绝写入");
  process.exit(3);
}
console.log(`[deploy] 时间止损口径 DEFAULT_MAX_HOLD_DAYS = ${DEFAULT_MAX_HOLD_DAYS}`);

const db = openDb();

/**
 * --restore=<备份.json>：把 prediction / outcome 两张表退回备份时的状态。
 *
 * 为什么脚本自带回滚而不是事后另写：口径部署这类操作，**发现口径错了**和
 * **把数据改回来**之间的时间差就是风险敞口。2026-10-23 第一次跑就是这样 ——
 * 部署完才发现时间止损不该套到"观察/清仓"上（它们不建仓），
 * 要是当时没有一条现成的回退路径，那批被改错的数就得手工往回凑。
 *
 * 只更新备份里存在的行：备份之后新结算的行不动，它们本来就不是这次改出来的。
 */
const restoreArg = process.argv.find(a => a.startsWith("--restore="));
if (restoreArg) {
  const file = restoreArg.split("=")[1];
  const snap = JSON.parse(fs.readFileSync(file, "utf8")) as {
    at: string;
    prediction: Array<Record<string, unknown>>;
    outcome: Array<Record<string, unknown>>;
  };
  console.log(`[deploy] 回滚到备份 ${file}（生成于 ${snap.at}）`);
  let np = 0;
  let no = 0;
  db.transaction(() => {
    for (const row of snap.prediction) {
      const id = row.id as string;
      const cols = Object.keys(row).filter(c => c !== "id");
      const sql = `UPDATE prediction SET ${cols.map(c => `"${c}" = ?`).join(", ")} WHERE id = ?`;
      np += db.prepare(sql).run(...cols.map(c => row[c] ?? null), id).changes;
    }
    for (const row of snap.outcome) {
      const id = row.pred_id as string;
      const cols = Object.keys(row).filter(c => c !== "pred_id");
      const sql = `UPDATE outcome SET ${cols.map(c => `"${c}" = ?`).join(", ")} WHERE pred_id = ?`;
      no += db.prepare(sql).run(...cols.map(c => row[c] ?? null), id).changes;
    }
  })();
  console.log(`[deploy] 已回滚 prediction ${np} 行 / outcome ${no} 行`);
  db.close();
  console.log("[deploy] rollback done");
  process.exit(0);
}

// ── 备份：只存本次会动的两张表，整库复制不划算 ────────────────────────────
const bakPath = path.join(
  path.dirname(resolved), `bak-${new Date().toISOString().slice(0, 10).replace(/-/g, "")}-preTimeExit.json`
);
const snap = {
  at: new Date().toISOString(),
  prediction: db.prepare("SELECT * FROM prediction").all(),
  outcome: db.prepare("SELECT * FROM outcome").all(),
};
fs.writeFileSync(bakPath, JSON.stringify(snap));
console.log(`[deploy] 已备份 prediction(${snap.prediction.length}) / outcome(${snap.outcome.length}) → ${bakPath}`);

const before = db.prepare(
  `SELECT p.id, p.code, p.action, p.eval_horizon, p.take_profit_px,
          o.verdict, o.actual_pct, o.entry_px, o.entry_date, o.dirty_reason, o.attribution
   FROM prediction p JOIN outcome o ON o.pred_id = p.id
   WHERE o.verdict != '作废'
   ORDER BY p.id`
).all() as Array<{
  id: string; code: string; action: string; eval_horizon: number; take_profit_px: number | null;
  verdict: string; actual_pct: number | null; entry_px: number | null;
  entry_date: string | null; dirty_reason: string | null; attribution: string | null;
}>;
const filledBefore = before.filter(r => r.entry_px != null).length;
console.log(`[deploy] 候选（已结算且未作废）${before.length} 行，其中已成交 ${filledBefore} 行`);

const n = resettlePriceBasis(db, new Date().toISOString());
console.log(`[deploy] resettlePriceBasis 本次重结 ${n} 行`);

let changedKind = 0;
for (const r of before) {
  const now = db.prepare(
    "SELECT verdict, actual_pct, entry_px, dirty_reason, attribution FROM outcome WHERE pred_id = ?"
  ).get(r.id) as
    | { verdict: string; actual_pct: number | null; entry_px: number | null;
        dirty_reason: string | null; attribution: string | null }
    | undefined;
  if (!now) continue;
  const changed = r.actual_pct == null || now.actual_pct == null
    ? r.actual_pct !== now.actual_pct
    : Math.abs(now.actual_pct - r.actual_pct) > 1e-9;
  if (!changed && (r.dirty_reason ?? null) === (now.dirty_reason ?? null)) continue;

  const kindBefore = /\((\S+?)\//.exec(r.attribution ?? "")?.[1] ?? "?";
  const kindAfter = /\((\S+?)\//.exec(now.attribution ?? "")?.[1] ?? "?";
  if (kindBefore !== kindAfter) changedKind++;
  console.log(
    `  ${r.id} ${r.code} ${r.action} D${r.eval_horizon}` +
    ` | actual ${r.actual_pct?.toFixed(2) ?? "-"}% -> ${now.actual_pct?.toFixed(2) ?? "-"}%` +
    ` | ${r.verdict} -> ${now.verdict}` +
    ` | 离场 ${kindBefore} -> ${kindAfter}` +
    ((r.dirty_reason == null && now.dirty_reason != null) ? " | ⚠ 新标脏" : "") +
    ((r.dirty_reason != null && now.dirty_reason == null) ? " | ✅ 脏标记解除" : "")
  );
}
console.log(`[deploy] 离场方式被改写的行数 ${changedKind} 行`);

const after = db.prepare(
  "SELECT COUNT(*) n FROM outcome o WHERE o.verdict != '作废' AND o.dirty_reason IS NOT NULL"
).get() as { n: number };
console.log(`[deploy] 剩余脏行 ${after.n} 行`);

// 幂等复核
const again = resettlePriceBasis(db, new Date().toISOString());
console.log(`[deploy] 幂等复核：第二遍重结 ${again} 行（应为 0）`);
if (again !== 0) {
  console.error("[deploy] ABORT: 不幂等，第二遍仍在改 —— 停下来查，不要继续跑");
  process.exit(4);
}

db.close();
console.log("[deploy] done");
