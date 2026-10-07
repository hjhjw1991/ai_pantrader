/**
 * x1 · 离场诊断：现有离场到底兑现了多少？
 *
 * 前置问题（来自 2026-10-07 主线 A/B 的最后一条线索）：
 *   板块层面"效应集中在短窗口"——1 日 +0.29、3 日 +0.19、5 日衰减、10 日全负。
 * 那是**板块**的未来收益，不是我们实际开仓的那些票的未来收益。
 * 离场是 100% 影响面的槽（每笔持仓都要判），所以可以先花一份力气把它量清楚。
 *
 * 本脚本不评估任何新规则，只回答三件事：
 *   ① 现在的离场都在什么原因上触发（止损 / 目标 / 期满各占多少）
 *   ② 从成交日算起，逐日累净值曲线长什么样（没有止损目标干预时）
 *   ③ 实际拿到手的收益占最大 favorable excursion 的多少（兑现率）
 *
 * 所有结论依赖模拟器与台账一致，所以先做一致性自检：
 * 用台账记录的 trigger/stop/target 重算一遍，逐笔比对 net_pct 与 exit_reason。
 * 对不上就说明模拟器算错了，后面的数字全是假的。
 */
import { loadCliEnv } from "@/lib/config";
loadCliEnv();
import { openDb } from "@/lib/db";
import { DEFAULT_CONSTRAINTS } from "@/lib/contracts/backtest";
import { 现行, scalePath, simulateExit, type PathBar, type RawBar } from "@/lib/shadow/exit-policy";

const db = openDb();

/* ---------------------------- 取：已结算的影子样本 ---------------------------- */

interface Trade {
  predId: string; variant: string; code: string;
  baseDate: string; entryDate: string; entryPx: number;
  triggerPx: number; stopPx: number | null; targetPx: number | null;
  baseAdj: number;
  recordedNet: number | null; recordedReason: string | null; recordedExit: string | null;
}

const rows = db.prepare(`
  SELECT p.id predId, p.variant_id variant, p.code, p.base_date baseDate,
         p.trigger_px triggerPx, p.stop_px stopPx, p.target_px targetPx,
         o.entry_date entryDate, o.entry_px entryPx, o.net_pct netPct,
         o.exit_reason reason, o.exit_date exitDate, o.mfe_pct mfe, o.mae_pct mae
    FROM shadow_pred p JOIN shadow_outcome o ON o.pred_id = p.id
   WHERE o.status = '已结算' AND p.source = 'replay' AND p.code != '-'
   ORDER BY p.variant_id, p.base_date, p.code
`).all() as Array<{
  predId: string; variant: string; code: string; baseDate: string;
  triggerPx: number; stopPx: number | null; targetPx: number | null;
  entryDate: string; entryPx: number; netPct: number;
  reason: string | null; exitDate: string | null; mfe: number | null; mae: number | null;
}>;

console.log(`已结算样本 ${rows.length} 笔`);

/* 逐变体计数 + 离场原因分布 */
const byVariant = new Map<string, Map<string, number>>();
for (const r of rows) {
  let m = byVariant.get(r.variant);
  if (!m) { m = new Map(); byVariant.set(r.variant, m); }
  m.set(r.reason ?? "?", (m.get(r.reason ?? "?") ?? 0) + 1);
}
console.log("\n变体 × 离场原因");
console.log("变体".padEnd(24), "笔数".padStart(6), "止损".padStart(7), "目标".padStart(7), "期满".padStart(7), "期满占比".padStart(9));
for (const [v, m] of [...byVariant].sort((a, b) => b[1].size - a[1].size)) {
  const n = [...m.values()].reduce((a, b) => a + b, 0);
  const g = (k: string) => m.get(k) ?? 0;
  const held = n - g("止损") - g("目标");
  console.log(v.padEnd(24), String(n).padStart(6), String(g("止损")).padStart(7),
    String(g("目标")).padStart(7), String(held).padStart(7), pct1(held / n).padStart(9));
}

/* ------------------------------ 取 K 线路径 ------------------------------ */

/**
 * 两个口径坑（本脚本第一版全踩了，是自检逐笔复算抓出来的）：
 *
 *   1. 路径必须**从成交日那一根开始**（>= entryDate）。成交日恒等于基准日之后的第一根
 *      （TRIGGER_WINDOW=1，settleShadow 只在 bars[0] 进场），写 `>` 会整体少一根，
 *      期满日跟着错一天、累净值曲线也偏一档。
 *   2. **别在读的时候就自己换算复权**。生产传给 settleShadow 的是原始价 + 各根的
 *      adj_factor，换算由它内部做；这里先按框架缩放一遍，等于缩放了两次。
 */
/**
 * 列名必须与 RawBar 的字段名一致（`adjFactor`）。
 * 早先这里别名写成 `adj`、再手工映射成 RawBar，改成直接 cast 后别名忘了跟着改，
 * 于是 adjFactor 全程是 undefined → 复权因子被当成 1 → 价格按未复权处理。
 * 这种错不会抛异常，只有逐笔自检能抓出来：4637 笔里错了 1818 笔。
 */
const barsStmt = db.prepare(`
  SELECT date, o, h, l, c, COALESCE(adj_factor, 1.0) AS adjFactor
    FROM kline_daily WHERE code = ? AND date >= ? ORDER BY date LIMIT 20
`);
const adjAtStmt = db.prepare(`SELECT COALESCE(adj_factor,1.0) f FROM kline_daily WHERE code=? AND date=?`);

interface Path { raw: RawBar[]; scaled: PathBar[] }

function loadPath(code: string, entryDate: string): Path | null {
  const raw = barsStmt.all(code, entryDate) as RawBar[];
  if (raw.length === 0) return null;
  // 换算一律走模块里的 scalePath（基准 = 成交日那一根）。自己再写一遍缩放，
  // 迟早把 adj 的基准弄错 —— 早先版本就是这么踩的。
  return { raw, scaled: scalePath(raw, 0) };
}

const paths = new Map<string, Path | null>();
function pathOf(code: string, entryDate: string): Path | null {
  const key = `${code}|${entryDate}`;
  if (!paths.has(key)) paths.set(key, loadPath(code, entryDate));
  return paths.get(key) ?? null;
}

/* --------------------- 自检：模拟器必须能逐笔复现台账 --------------------- */

/**
 * 自检走 lib/shadow/exit-policy 这一份实现，不再直接调 settleShadow。
 *
 * 早先这里是把 settleShadow 当作"参照实现"来比对的（当时新模块还没立住）。
 * 现在 x2 已经证明新模块能 4637/4637 逐笔复现 settleShadow，
 * 于是参照改成了"台账已落定的结果" —— 少一处重复实现，也少一处两边漂移的机会。
 */
let ok = 0, bad = 0, noPath = 0;
const badCases: string[] = [];
for (const r of rows) {
  const p = pathOf(r.code, r.entryDate);
  if (p === null || p.raw.length === 0) { noPath++; continue; }
  const adjBase = (adjAtStmt.get(r.code, r.baseDate) as { f: number } | undefined)?.f ?? 1;
  const adjEntry = p.raw[0].adjFactor ?? 1;
  const k = adjBase / (adjEntry > 0 ? adjEntry : 1);
  const s = simulateExit(现行, {
    path: p.scaled, entryPx: r.entryPx,
    planStopPx: r.stopPx === null ? null : r.stopPx * k,
    planTargetPx: r.targetPx === null ? null : r.targetPx * k,
    slippage: DEFAULT_CONSTRAINTS.slippage, feeRate: DEFAULT_CONSTRAINTS.feeRate,
  });
  if (s.status !== "已结算" || s.exitIdx === null) { noPath++; continue; }
  const sameNet = Math.abs((s.netPct ?? NaN) - r.netPct) < 1e-4;
  const sameReason = p.raw[s.exitIdx].date === r.exitDate && s.reason === r.reason;
  if (sameNet && sameReason) ok++;
  else {
    bad++;
    if (badCases.length < 5) badCases.push(`${r.variant} ${r.code} ${r.entryDate} 台账 ${r.netPct}(${r.reason}@${r.exitDate}) 复算 ${s.netPct}(${s.reason}@${p.raw[s.exitIdx].date})`);
  }
}
console.log(`\n模拟器自检：复现 ${ok} 笔，不符 ${bad} 笔，无足够 K 线 ${noPath} 笔`);
if (badCases.length > 0) { console.log(badCases.join("\n")); }
if (bad > 0) {
  console.log("\n模拟器与台账不一致 —— 后面的数字不可信，先修模拟器。");
  process.exit(1);
}

/* -------------------------- ① 逐日累净值曲线 -------------------------- */

/**
 * 无干预曲线：成交日收盘进场（第 0 根），此后第 i 根收盘走人。
 * 用收盘价是为了看"这段路程本身值多少钱"，与任何止损/目标无关。
 */
const HMAX = 12;
console.log("\n① 从成交日起的逐日累计净值（%），无止损无目标、第 i 日收盘离场");
console.log("范围".padEnd(22), "笔数".padStart(6), ...[...Array(HMAX)].map((_, i) => `D${i + 1}`.padStart(8)));

function curve(label: string, subset: typeof rows) {
  const acc: number[][] = [...Array(HMAX)].map(() => []);
  let n = 0;
  for (const r of subset) {
    const p = pathOf(r.code, r.entryDate);
    if (p === null || p.scaled.length < 2) continue;
    const entry = r.entryPx;
    if (!(entry > 0)) continue;
    n++;
    for (let i = 1; i < p.scaled.length && i <= HMAX; i++) acc[i - 1].push((p.scaled[i].c / entry - 1) * 100);
  }
  console.log(label.padEnd(22), String(n).padStart(6),
    ...acc.map(a => (a.length ? mean(a) : NaN).toFixed(3).padStart(8)));
  return n;
}

function mean(x: number[]): number { return x.length ? x.reduce((a, b) => a + b, 0) / x.length : NaN; }
function sd(x: number[]): number { const m = mean(x); return Math.sqrt(x.reduce((a, b) => a + (b - m) ** 2, 0) / (x.length - 1)); }
function pct1(x: number): string { return `${(x * 100).toFixed(1)}%`; }

curve("全部变体", rows);
for (const v of ["baseline", "cycle+pricing", "sw", "pricing"]) {
  const s = rows.filter(r => r.variant === v);
  if (s.length > 30) curve(`　${v}`, s);
}

/* ------------------------ ② 兑现率：拿到手 / 曾有过 ------------------------ */

console.log("\n② 兑现率：实际净收益占持有期内最好水平（MFE）的比例");
console.log("范围".padEnd(22), "笔数".padStart(6), "期望%".padStart(9), "胜率".padStart(8), "MFE均值".padStart(9), "MAE均值".padStart(9), "兑现率".padStart(9));
function realized(label: string, subset: typeof rows) {
  const nets = subset.map(r => r.netPct).filter((x): x is number => typeof x === "number");
  const mfes = subset.map(r => r.mfe).filter((x): x is number => x !== null);
  const maes = subset.map(r => r.mae).filter((x): x is number => x !== null);
  const n = nets.length;
  const win = nets.filter(x => x > 0).length;
  const mMfe = mean(mfes), mMae = mean(maes);
  if (!Number.isFinite(mMfe)) return;
  console.log(label.padEnd(22), String(n).padStart(6), mean(nets).toFixed(3).padStart(9),
    pct1(win / n).padStart(8), mMfe.toFixed(3).padStart(9), mMae.toFixed(3).padStart(9),
    pct1(mean(nets) / mMfe).padStart(9));
}
realized("全部变体", rows);
for (const v of ["baseline", "cycle+pricing", "sw", "pricing"]) {
  const s = rows.filter(r => r.variant === v);
  if (s.length > 30) realized(`　${v}`, s);
}

/* ---------------- ③ 触线情况：止盈目标到底够得着吗 ---------------- */

console.log("\n③ 持有期内曾触及的阈值（按成交价算的最高/最低）");
console.log("范围".padEnd(22), "笔数".padStart(6), ...[3, 4, 5, 6, 8, 10, 15].map(t => `≥${t}%`.padStart(8)));
function touched(label: string, subset: typeof rows) {
  const th = [3, 4, 5, 6, 8, 10, 15];
  const hit = th.map(() => 0);
  let n = 0;
  for (const r of subset) {
    const p = pathOf(r.code, r.entryDate);
    if (p === null || p.scaled.length < 2) continue;
    const entry = r.entryPx;
    if (!(entry > 0)) continue;
    n++;
    let hi = p.scaled[0].h;
    for (let i = 1; i < p.scaled.length && i <= 5 - 1; i++) hi = Math.max(hi, p.scaled[i].h);
    const up = (hi / entry - 1) * 100;
    th.forEach((t, j) => { if (up >= t) hit[j]++; });
  }
  console.log(label.padEnd(22), String(n).padStart(6), ...hit.map((h, j) => pct1(h / n).padStart(8)));
}
touched("全部变体（5日内）", rows);
const base = rows.filter(r => r.variant === "baseline");
if (base.length > 30) touched("　baseline（5日内）", base);
