/**
 * 用影子盘历史预测（19,100 条，2023-11 → 2026-09）复扫买入折让。
 *
 * 为什么必须跑这一遍：台账只有 39 条看涨信号、且集中在 2026-09~10 一个月，
 * 它给出的"折让越深越好（−8%）"与引擎里那份 19,820 条的实测结论（−3% 最优、
 * −5% 反而变差）**方向相反**。39 条推翻不了 19,820 条，但那份研究量的是
 * 「日度组合收益」，本脚本量的是「每信号期望」——两者可以都对：
 * 折让深 → 每笔更赚但成交更少，资金闲置拉低日度收益。
 * 到底哪个该听，要用**同一套代码、同一口径**在大样本上再扫一遍才说得清。
 *
 * 口径：D5 期满、限价低吸（min(开盘, 触发价)）、未成交记 0 且留在分母里。
 * 影子盘自己的离场是槽位规则，这里一律不用 —— 要问的是入场折让这一个轴，
 * 离场口径两组必须完全一致。
 *
 * 用法：PANTRADER_DATA_DIR=... npx tsx scripts/shadow_sweep.ts [--limit=N] [--variant=id]
 */
import { loadCliEnv } from "@/lib/config";
loadCliEnv();
import { openDb } from "@/lib/db";
import {
  loadSampleBars, policyGridSearch, scorePolicy, type ClosedSample, type ExitRule,
} from "@/lib/ledger/policy-lab";
import { adjFactorOn, tradingDayOffset } from "@/lib/ledger/reconcile";

const argNum = (k: string): number | null => {
  const m = process.argv.find(a => a.startsWith(`--${k}=`));
  return m ? Number(m.split("=")[1]) : null;
};
const limit = argNum("limit");
const variant = process.argv.find(a => a.startsWith("--variant="))?.split("=")[1];

const db = openDb();

const where = variant ? "WHERE variant_id = ?" : "";
const params = variant ? [variant] : [];
const rows = db.prepare(
  `SELECT id, variant_id, base_date, code, trigger_px FROM shadow_pred ${where}`
).all(...params) as Array<{
  id: string; variant_id: string; base_date: string; code: string; trigger_px: number | null;
}>;
const picked = limit ? rows.slice(0, limit) : rows;
console.log(`[shadow] 影子盘预测 ${rows.length} 条，本次取 ${picked.length} 条${variant ? `（变体 ${variant}）` : ""}`);

const samples: ClosedSample[] = [];
for (const r of picked) {
  if (r.trigger_px == null) continue;
  const end = tradingDayOffset(db, r.base_date, 5);
  if (end == null) continue;
  samples.push({
    predId: r.id, code: r.code, action: "买入", horizon: 5, base: r.base_date,
    entryPx: null, entryDate: null, holdFrom: null, horizonEnd: end,
    triggerPxAdj: r.trigger_px * adjFactorOn(db, r.code, r.base_date),
  });
}
const all = loadSampleBars(db, samples);
console.log(`[shadow] 可重放 ${all.length} 条（需基准日与后续 5 个交易日都有行情）`);

const DISCOUNTS: Array<number | null> = [null, 0, -1, -2, -3, -5, -8, -10, -15];
const WINDOWS = [1, 3, 5];

for (const [label, exit] of [
  ["纯期满", { takeProfitPct: null, stopPct: null, trailPct: null } as ExitRule],
  ["止盈8/止损8", { takeProfitPct: 8, stopPct: 8, trailPct: null } as ExitRule],
] as Array<[string, ExitRule]>) {
  console.log(`\n[shadow] ${label}：`);
  console.log("  折让    窗口   每信号期望   成交率   已成交均值");
  for (const d of DISCOUNTS) {
    for (const w of WINDOWS) {
      const s = scorePolicy(all, { discountPct: d, windowDays: w }, exit);
      console.log(
        `  ${(d == null ? "台账价" : (d > 0 ? "+" : "") + d + "%").padStart(6)}  ${w}天` +
        `  ${s.meanPct.toFixed(3).padStart(8)}%   ${(s.fillRate * 100).toFixed(0).padStart(3)}%` +
        `   ${s.meanPctFilled.toFixed(2).padStart(7)}%`
      );
    }
  }
}

// ── 离场规则：在大样本上扫 + 时间切分样本外验证 ────────────────────────────
const DISC: Array<number | null> = [null, 0];
const TPS: Array<number | null> = [null, 5, 8, 10, 15, 20];
const SLS: Array<number | null> = [null, 5, 8, 10, 15];
const TRAILS: Array<number | null> = [null, 5, 8];
const byDate = [...all].sort((a, b) => a.sample.base.localeCompare(b.sample.base));
const cut = Math.floor(byDate.length * 0.7);
const isSet = byDate.slice(0, cut);
const oosSet = byDate.slice(cut);
console.log(
  `\n[shadow] 时间切分：样本内 ${isSet.length} 条（至 ${isSet[isSet.length - 1].sample.base}），` +
  `样本外 ${oosSet.length} 条（${oosSet[0].sample.base} 起）`
);

const combos: Array<{ d: number | null; tp: number | null; sl: number | null; tr: number | null }> = [];
for (const d of DISC) for (const tp of TPS) for (const sl of SLS) for (const tr of TRAILS) {
  combos.push({ d, tp, sl, tr });
}
const scored = combos.map(c => {
  const ex: ExitRule = { takeProfitPct: c.tp, stopPct: c.sl, trailPct: c.tr };
  return {
    c, is: scorePolicy(isSet, { discountPct: c.d, windowDays: 5 }, ex),
    oos: scorePolicy(oosSet, { discountPct: c.d, windowDays: 5 }, ex),
  };
});
let bestIs = scored[0];
for (const x of scored) if (x.is.meanPct > bestIs.is.meanPct) bestIs = x;
let bestOos = scored[0];
for (const x of scored) if (x.oos.meanPct > bestOos.oos.meanPct) bestOos = x;

console.log("\n[shadow] 单轴：止盈（其余为 纯期满，折让0/窗口5）");
for (const tp of TPS) {
  const x = scored.find(s => s.c.tp === tp && s.c.sl == null && s.c.tr == null && s.c.d === 0)!;
  console.log(`  止盈 ${String(tp ?? "不设").padStart(4)} → 样本内 ${x.is.meanPct.toFixed(3)}%  样本外 ${x.oos.meanPct.toFixed(3)}%`);
}
console.log("[shadow] 单轴：止损");
for (const sl of SLS) {
  const x = scored.find(s => s.c.sl === sl && s.c.tp == null && s.c.tr == null && s.c.d === 0)!;
  console.log(`  止损 ${String(sl ?? "不设").padStart(4)} → 样本内 ${x.is.meanPct.toFixed(3)}%  样本外 ${x.oos.meanPct.toFixed(3)}%`);
}
console.log("[shadow] 单轴：移动止损");
for (const tr of TRAILS) {
  const x = scored.find(s => s.c.tr === tr && s.c.tp == null && s.c.sl == null && s.c.d === 0)!;
  console.log(`  移动 ${String(tr ?? "不设").padStart(4)} → 样本内 ${x.is.meanPct.toFixed(3)}%  样本外 ${x.oos.meanPct.toFixed(3)}%`);
}

const fmtEx = (c: typeof bestIs.c) => `止盈 ${c.tp ?? "-"} 止损 ${c.sl ?? "-"} 移动 ${c.tr ?? "-"} 折让 ${c.d ?? "台账价"}`;
console.log(`\n[shadow] 样本内最优：${fmtEx(bestIs.c)} → 样本内 ${bestIs.is.meanPct.toFixed(3)}%  样本外 ${bestIs.oos.meanPct.toFixed(3)}%`);
console.log(`[shadow] 样本外最优：${fmtEx(bestOos.c)} → 样本内 ${bestOos.is.meanPct.toFixed(3)}%  样本外 ${bestOos.oos.meanPct.toFixed(3)}%`);
console.log("[shadow] 样本内前 8 及其样本外表现（看选出来的参数能不能泛化）：");
for (const x of [...scored].sort((a, b) => b.is.meanPct - a.is.meanPct).slice(0, 8)) {
  console.log(
    `  ${fmtEx(x.c)}  样本内 ${x.is.meanPct.toFixed(3)}%  →  样本外 ${x.oos.meanPct.toFixed(3)}%  成交率 ${(x.oos.fillRate * 100).toFixed(0)}%`
  );
}

console.log("\n[shadow] 大样本网格寻优（含选择偏差）：");
const exits: ExitRule[] = [
  { takeProfitPct: null, stopPct: null, trailPct: null },
  { takeProfitPct: 8, stopPct: 8, trailPct: null },
  { takeProfitPct: 8, stopPct: null, trailPct: null },
];
const g = policyGridSearch(all, DISCOUNTS, WINDOWS, exits);
console.log(
  `  最优点：折让 ${g.best.entry.discountPct}%  窗口 ${g.best.entry.windowDays}天  ` +
  `止盈 ${g.best.exit.takeProfitPct} 止损 ${g.best.exit.stopPct}` +
  ` → 每信号 ${g.best.meanPct.toFixed(3)}%  成交率 ${(g.best.fillRate * 100).toFixed(0)}%`
);
console.log(`  ${g.selection.note}`);

db.close();
