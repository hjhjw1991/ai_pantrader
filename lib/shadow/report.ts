/**
 * 影子盘成绩单：从台账读样本，每个变体一份 Summary，外加相对 baseline 的差异。
 */
import type { Db } from "@/lib/db";
import { summarize, welch, type Summary, type Trade } from "@/lib/shadow/stats";
import { BASELINE_VARIANT } from "@/lib/shadow/variants";

export type Source = "live" | "replay";

export function loadTrades(db: Db, variantId: string, source: Source): Trade[] {
  return (db.prepare(
    `SELECT o.status, o.net_pct, o.exit_date, o.exit_reason, p.stage, p.base_date
       FROM shadow_pred p JOIN shadow_outcome o ON o.pred_id = p.id
      WHERE p.variant_id = ? AND p.source = ? AND p.code != '-'
      ORDER BY p.base_date, p.id`
  ).all(variantId, source) as any[]).map(r => ({
    status: r.status, netPct: r.net_pct, exitDate: r.exit_date, exitReason: r.exit_reason,
    stage: r.stage, baseDate: r.base_date,
  }));
}

export interface VariantReport {
  id: string;
  name: string;
  status: string;
  summary: Summary;
  /** 这个变体跑过的基准日数（含 0 候选的日子）—— 毕业门槛里"实盘 ≥ 20 个交易日"数的就是它 */
  days: number;
  /** 期望（平均净收益）相对 baseline 的差与 Welch t。baseline 自己为 null */
  vsBaseline: { diff: number; t: number; se: number } | null;
}

export function variantReports(db: Db, source: Source): VariantReport[] {
  const vs = db.prepare("SELECT id, name, status FROM shadow_variant ORDER BY id").all() as Array<{ id: string; name: string; status: string }>;
  const dayCount = db.prepare("SELECT COUNT(DISTINCT base_date) AS n FROM shadow_pred WHERE variant_id = ? AND source = ?");
  const trades = new Map(vs.map(v => [v.id, loadTrades(db, v.id, source)]));
  const netOf = (ts: Trade[]) => ts.filter(t => t.status === "已结算" && t.netPct !== null).map(t => t.netPct as number);
  const base = netOf(trades.get(BASELINE_VARIANT) ?? []);
  return vs.map(v => ({
    id: v.id, name: v.name, status: v.status,
    summary: summarize(trades.get(v.id)!),
    days: Number((dayCount.get(v.id, source) as { n: number }).n),
    vsBaseline: v.id === BASELINE_VARIANT ? null : welch(netOf(trades.get(v.id)!), base),
  }));
}
