/**
 * x2 · 离场规则的配对评测
 *
 * 为什么离场侧是全场唯一有足够功效的实验：
 *   入场侧改动只有 12.4% 的交易日真正换了股票，稀释后可检出效应需 8.5%/笔
 *   （2026-10-07 主线 A/B 的功效分析），历史根本攒不出那么多样本。
 *   离场侧没有这个问题 —— 每笔存量持仓都要判离场，影响面 100%，
 *   而且能做**配对**：同一笔入场、同一条价格路径，只换离场规则。
 *   比的不是两群票，是一群票的两种走法，差的方差比收益本身的方差小一个量级。
 *
 * 所有候选规则都是**当日可判定**的（只用截至今日的 K 线），没有未来函数。
 * 用未来 K 线推进是被允许的：那是标签不是特征 —— 规则在每一天都不知道明天。
 *
 * ⚠️ 读这张表之前必须先看「影响面」列。
 *   一条规则一个样本都没改动，它的 +0.000 是**没生效**，不是"证明无效"。
 *   两者在结果表上长得一模一样（第一版的破均线就是这样，原因是没喂入场前的 K 线）。
 *
 * 自检先行：模拟器必须逐笔复现 settleShadow 的现行口径，对不上就整体作废。
 */
import { loadCliEnv } from "@/lib/config";
loadCliEnv();
import { openDb } from "@/lib/db";
import { DEFAULT_CONSTRAINTS } from "@/lib/contracts/backtest";
import { 现行, simulateExit, scalePath, type ExitPolicy, type PathBar } from "@/lib/shadow/exit-policy";

const db = openDb();

/* ------------------------------- 取样本 ------------------------------- */

interface Row {
  variant: string; code: string; baseDate: string; entryDate: string; entryPx: number;
  triggerPx: number; stopPx: number | null; targetPx: number | null;
  recordedNet: number; recordedReason: string | null; recordedExit: string | null;
}

const rows = db.prepare(`
  SELECT p.variant_id variant, p.code, p.base_date baseDate,
         p.trigger_px triggerPx, p.stop_px stopPx, p.target_px targetPx,
         o.entry_date entryDate, o.entry_px entryPx, o.net_pct recordedNet,
         o.exit_reason recordedReason, o.exit_date recordedExit
    FROM shadow_pred p JOIN shadow_outcome o ON o.pred_id = p.id
   WHERE o.status='已结算' AND p.source='replay' AND p.code != '-'
   ORDER BY p.base_date, p.code
`).all() as Row[];

const winStmt = db.prepare(`
  SELECT date, o, h, l, c, COALESCE(adj_factor,1.0) adjFactor
    FROM kline_daily WHERE code=? AND date>=? AND date<=? ORDER BY date
`);
const adjAtStmt = db.prepare(`SELECT COALESCE(adj_factor,1.0) f FROM kline_daily WHERE code=? AND date=?`);

function shiftDays(d: string, days: number): string {
  return new Date(new Date(`${d}T00:00:00Z`).getTime() + days * 86400000).toISOString().slice(0, 10);
}

const cache = new Map<string, { path: PathBar[]; prior: PathBar[]; k: number } | null>();
function loadOf(r: Row) {
  const key = `${r.code}|${r.entryDate}`;
  if (cache.has(key)) return cache.get(key) ?? null;
  const raw = winStmt.all(r.code, shiftDays(r.entryDate, -70), shiftDays(r.entryDate, 200)) as Array<{ date: string; o: number; h: number; l: number; c: number; adjFactor: number }>;
  const idx = raw.findIndex(b => b.date === r.entryDate);
  if (idx < 0) { cache.set(key, null); return null; }
  // 基准必须是**成交日那一根**（scalePath 第二参）：用窗口最老那根会把有除权的票整体缩放
  const scaled = scalePath(raw, idx);
  const adjBase = (adjAtStmt.get(r.code, r.baseDate) as { f: number } | undefined)?.f ?? 1;
  const adjEntry = raw[idx].adjFactor > 0 ? raw[idx].adjFactor : 1;
  const out = { path: scaled.slice(idx, idx + 30), prior: scaled.slice(Math.max(0, idx - 40), idx), k: adjBase / adjEntry };
  cache.set(key, out);
  return out;
}

/** 每笔预先备好的数据与成本核算，避免后面反复查库 */
const loaded: Array<ReturnType<typeof loadOf>> = rows.map(r => loadOf(r));

/* --------------------- 自检：现行口径必须复现 settleShadow --------------------- */

{
  let okN = 0, bad = 0, unsettled = 0;
  const samples: string[] = [];
  rows.forEach((r, i) => {
    const c = loaded[i];
    if (c === null) { unsettled++; samples.push(`${r.variant} ${r.code} ${r.entryDate} 取不到K线`); return; }
    const s = simulateExit(现行, {
      path: c.path, prior: c.prior, entryPx: r.entryPx,
      planStopPx: r.stopPx === null ? null : r.stopPx * c.k,
      planTargetPx: r.targetPx === null ? null : r.targetPx * c.k,
      slippage: DEFAULT_CONSTRAINTS.slippage, feeRate: DEFAULT_CONSTRAINTS.feeRate,
    });
    if (s.status !== "已结算") { unsettled++; if (samples.length < 4) samples.push(`${r.variant} ${r.code} ${r.entryDate} 未能结算(${s.status})`); return; }
    if (Math.abs((s.netPct ?? NaN) - r.recordedNet) < 1e-4 && s.exitIdx !== null && c.path[s.exitIdx].date === r.recordedExit) okN++;
    else { bad++; if (samples.length < 4) samples.push(`${r.variant} ${r.code} ${r.entryDate} 台账 ${r.recordedNet.toFixed(4)}(${r.recordedExit}) 本模块 ${(s.netPct ?? NaN).toFixed(4)}(${c.path[s.exitIdx!]?.date})`); }
  });
  console.log(`自检（现行口径逐笔复现）：一致 ${okN}/${rows.length} 笔，不符 ${bad}，未结算 ${unsettled}`);
  if (samples.length) console.log("　" + samples.join("\n　"));
  if (bad > 0 || unsettled > 0) { console.log("\n模拟器没复现现行口径，后面的数字不可信。"); process.exit(1); }
}

/* ------------------------------- 统计工具 ------------------------------- */

const mean = (x: number[]) => x.reduce((a, b) => a + b, 0) / x.length;
const sd = (x: number[]) => { const m = mean(x); return Math.sqrt(x.reduce((a, b) => a + (b - m) ** 2, 0) / (x.length - 1)); };
const quantile = (x: number[], p: number) => { const s = [...x].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const f = (x: number, w = 3, p = 0) => (Number.isFinite(x) ? x.toFixed(w) : "—").padStart(p);

/**
 * 每个政策的每笔结果，**按 rows 的下标对齐**。
 *
 * 早先用 `nets.push()` 密集建数组：只要有一个政策漏掉一笔没结算，后面每笔的下标就整体错位。
 * 而它不会报错，只会让配对差 quietly 失去意义。逐行存 null，缺失就留在原处，错位不可能发生。
 */
const evaluated = new Map<string, { net: Array<number | null>; held: Array<number | null> }>();

function evaluate(pol: ExitPolicy): { net: Array<number | null>; held: Array<number | null> } {
  const key = JSON.stringify(pol);
  const hit = evaluated.get(key);
  if (hit) return hit;
  const net: Array<number | null> = rows.map(() => null);
  const held: Array<number | null> = rows.map(() => null);
  rows.forEach((r, i) => {
    const c = loaded[i];
    if (c === null) return;
    const s = simulateExit(pol, {
      path: c.path, prior: c.prior, entryPx: r.entryPx,
      planStopPx: r.stopPx === null ? null : r.stopPx * c.k,
      planTargetPx: r.targetPx === null ? null : r.targetPx * c.k,
      slippage: DEFAULT_CONSTRAINTS.slippage, feeRate: DEFAULT_CONSTRAINTS.feeRate,
    });
    if (s.status !== "已结算" || s.netPct === null) return;
    net[i] = s.netPct;
    held[i] = s.held ?? null;
  });
  const out = { net, held };
  evaluated.set(key, out);
  return out;
}

/**
 * 单维聚类稳健 t（双向 Hansen CR1 简化版：一维、按入场日聚）。
 *
 * 同一天入场的票相关（同一个大盘环境、同一批候选），当独立观测会严重高估显著性 ——
 * 这一条在上一轮主线 A/B 里已经付过学费。
 *
 * 关键是**点估计不能跟着聚类一起换**: t 用聚类稳健的标准误，分子仍是逐笔平均差，
 * 与表格里的「Δ vs 参照」是同一个数。早先版本把分子写成"日均值再求平均"，
 * 于是 Δ 列看着像是对得上的数、实际是按日等权 —— 与期望列的差整整差了一倍。
 */
function clusterRobustT(a: ReturnType<typeof evaluate>, b: ReturnType<typeof evaluate>, idxRow: number[]) {
  const diffs: number[] = [], groups = new Map<string, number[]>();
  for (const i of idxRow) {
    const av = a.net[i], bv = b.net[i];
    if (av === null || bv === null) continue;
    const d = av - bv;
    diffs.push(d);
    const day = rows[i].entryDate;
    const arr = groups.get(day);
    if (arr) arr.push(d); else groups.set(day, [d]);
  }
  const N = diffs.length, G = groups.size;
  if (N < 3 || G < 2) return { dMean: N ? mean(diffs) : NaN, t: NaN, clusters: G };
  const m = mean(diffs);
  let V = 0;
  for (const arr of groups.values()) {
    const u = arr.reduce((s, d) => s + (d - m), 0);
    V += u * u;
  }
  const se = Math.sqrt(V) / N;
  const t = se > 0 ? m / se : NaN;
  return { dMean: m, t, clusters: G };
}

/* ------------------------------- 出表 ------------------------------- */

/**
 * 表格：给一组政策出一行一行。
 * `pick` 用来限定样本子集（比如"只取开仓计划里没有目标价的那些笔"，
 * 免得评估器自带的结构位目标把"政策的目标"搅浑 —— 那样测的就不是政策了）。
 */
function table(title: string, entries: Array<[string, ExitPolicy]>, ref: ExitPolicy, note?: string, pick?: number[]) {
  const A = evaluate(ref);
  console.log(`\n${title}`);
  if (note) console.log(`　${note}`);
  if (pick) console.log(`　样本：${pick.length} 笔（已限定子集）`);
  console.log("　" + "政策".padEnd(26), "期望%".padStart(8), "胜率".padStart(7), "持有日".padStart(7),
    "每日期望".padStart(9), "5%分位".padStart(8), "尾部改善".padStart(9), "影响面".padStart(8),
    "Δ vs 参照".padStart(10), "t(聚类)".padStart(8));
  console.log("　" + "-".repeat(104));
  for (const [name, pol] of entries) {
    const R = evaluate(pol);
    printRow(name, R, A, pol === ref, pick);
  }
}

function picker(all: number[], pol: ReturnType<typeof evaluate>, A: ReturnType<typeof evaluate>, pick?: number[]): number[] {
  const base = pick ?? all;
  return base.filter(i => pol.net[i] !== null && A.net[i] !== null);
}

function printRow(name: string, R: ReturnType<typeof evaluate>, A: ReturnType<typeof evaluate>, isRef: boolean, pick?: number[]) {
  const all = rows.map((_, i) => i);
  const ids = picker(all, R, A, pick);
  const nets = all.map(i => R.net[i]!);
  const held = all.map(i => R.held[i]!).filter((x): x is number => x !== null);
  const n = nets.length;
  const exp = mean(nets);
  const tail = quantile(nets, 0.05);
  const tailRef = quantile(all.map(i => A.net[i]!), 0.05);
  // 影响面：与**参照政策**（不是台账）比，多少笔的结局真的变了
  const changed = all.filter(i => Math.abs(R.net[i]! - A.net[i]!) > 1e-6).length / n;
  let dMean = NaN, t = NaN;
  if (!isRef && n > 0) { const r = clusterRobustT(R, A, all); dMean = r.dMean; t = r.t; }
  console.log("　" + name.padEnd(26), f(exp, 3, 8), `${(nets.filter(x => x > 0).length / n * 100).toFixed(1)}%`.padStart(7),
    f(mean(held), 2, 7), f(exp / mean(held), 3, 9), f(tail, 2, 8), f(tail - tailRef, 2, 9),
    `${(changed * 100).toFixed(1)}%`.padStart(8),
    (isRef ? "　（参照）".padStart(10) : f(dMean, 3, 10)), f(t, 2, 8));
}

const allIdx = rows.map((_, i) => i).filter(i => loaded[i] !== null);

/* ① 到期：这是最重要的一组，因为它回答"该拿多久" */
console.log(`\n样本 ${allIdx.length} 笔（replay 已结算）， ${new Set(allIdx.map(i => rows[i].entryDate)).size} 个入场交易日`);
table("① 持有上限：现行是 5 日期满，该拿多久？",
  [
    ["现行（到期5日）", 现行],
    ["到期3日", { ...现行, 到期: 3 }],
    ["到期4日", { ...现行, 到期: 4 }],
    ["到期6日", { ...现行, 到期: 6 }],
    ["到期8日", { ...现行, 到期: 8 }],
    ["到期12日", { ...现行, 到期: 12 }],
    ["到期20日（近似不限）", { ...现行, 到期: 20 }],
  ], 现行,
  "实盘账户纪律**没有到期这一条**，仓位可以一直拿着 —— 这一组回答的就是要不要给它加个上限");

/* ② 目标位 */
table("② 目标位（9% 为 null 时等于完全不止盈）",
  [
    ["现行（无目标）", 现行],
    ["目标+3%", { ...现行, 目标: 3 }],
    ["目标+4%", { ...现行, 目标: 4 }],
    ["目标+5%", { ...现行, 目标: 5 }],
    ["目标+6%（YAML值）", { ...现行, 目标: 6 }],
    ["目标+8%", { ...现行, 目标: 8 }],
    ["目标+10%", { ...现行, 目标: 10 }],
  ], 现行);

/* ③ 止损类 */
table("③ 止损类：抬高止损保住浮盈，看起来总是对的",
  [
    ["现行（固定止损）", 现行],
    ["保本：盈3%后抬到成本", { ...现行, 移动止损: { 起: 3, 回撤: 3 } }],
    ["保本：盈5%后抬到成本", { ...现行, 移动止损: { 起: 5, 回撤: 5 } }],
    ["移动：盈5%后回撤3%", { ...现行, 移动止损: { 起: 5, 回撤: 3 } }],
    ["移动：盈8%后回撤4%", { ...现行, 移动止损: { 起: 8, 回撤: 4 } }],
    ["移动：盈10%后回撤5%", { ...现行, 移动止损: { 起: 10, 回撤: 5 } }],
  ], 现行,
  "注：2026-09-27 的回放早就给过一条相反证据 —— 8% 机械止损把毛利从 +0.670%/笔 拉到 +0.584%/笔");

/* ④ 破均线 */
table("④ 破均线（收盘价跌破 N 日线就走）",
  [
    ["现行", 现行],
    ["破MA3", { ...现行, 破均线: 3 }],
    ["破MA5", { ...现行, 破均线: 5 }],
    ["破MA10", { ...现行, 破均线: 10 }],
    ["破MA20", { ...现行, 破均线: 20 }],
  ], 现行);

/* ⑤ 时间止损 */
table("⑤ 时间止损：到第 N 日收盘还亏就走",
  [
    ["现行", 现行],
    ["第2日仍亏就走", { ...现行, 时间止损: { 第几日: 2, 低于: 0 } }],
    ["第3日仍亏就走", { ...现行, 时间止损: { 第几日: 3, 低于: 0 } }],
    ["第4日仍亏就走", { ...现行, 时间止损: { 第几日: 4, 低于: 0 } }],
    ["第5日仍亏就走", { ...现行, 时间止损: { 第几日: 5, 低于: 0 } }],
  ], 现行);

/* ⑥ 决赛：把正效应的叠起来 */
const 短持 = { ...现行, 到期: 4 };
table("⑥ 决赛：① 里最好的一只 + 其余 gains 能不能叠加",
  [
    ["到期4日", 短持],
    ["到期4日 + 目标6%", { ...短持, 目标: 6 }],
    ["到期4日 + 保本3%", { ...短持, 移动止损: { 起: 3, 回撤: 3 } }],
    ["到期4日 + 第3日仍亏走", { ...短持, 时间止损: { 第几日: 3, 低于: 0 } }],
    ["到期4日 + 破MA5", { ...短持, 破均线: 5 }],
    ["到期4日 + 目标6% + 第3日仍亏走", { ...短持, 目标: 6, 时间止损: { 第几日: 3, 低于: 0 } }],
    ["现行（参照）", 现行],
  ], 短持, "参照换成「到期4日」，看叠加上去的每一条还有没有增量");

/* ============ ⑦ 决策相关的一张表：按**实盘口径**比，不是按影子结算口径 ============ */

/**
 * 影子盘的结算口径（-10% 计划止损、无目标、5 日期满）**不是**实盘在跑的那套。
 * 实盘 账户纪律 是： -10% 止损（收盘确认）、-15% 灾难位、+6% 清仓，**没有时间上限**。
 * 所以真正要回答的问题是：给现有这套加一个时间上限，值不值？
 * 这里把参照设成"近似实盘"（把上限放到 20 日，等于没有），再逐档收回来。
 */
const 实盘口径: ExitPolicy = { 到期: 20, 目标: 6, 硬止损: -10, 移动止损: null, 破均线: null, 时间止损: null };
table("⑦ 实盘口径：现有的 -10% 止损 / +6% 目标 / 无时间上限，加一个上限值不值？",
  [
    ["现行（无上限）", 实盘口径],
    ["+上限3日", { ...实盘口径, 到期: 3 }],
    ["+上限4日", { ...实盘口径, 到期: 4 }],
    ["+上限5日", { ...实盘口径, 到期: 5 }],
    ["+上限6日", { ...实盘口径, 到期: 6 }],
    ["+上限8日", { ...实盘口径, 到期: 8 }],
    ["+上限4日 + 破MA3", { ...实盘口径, 到期: 4, 破均线: 3 }],
  ], 实盘口径,
  "这张表才是对实盘的建议表；前面几张是在问「各种规则有没有用」，这张是在问「具体该配哪一档」");

/* ============ ⑧ 稳健性：赢的那几条，是不是每个子集都成立 ============ */

const FAMILY = (v: string) => v.startsWith("hm-") ? "游资(hm-*)"
  : v.startsWith("sw") ? "申万主线(sw*)"
    : v === "baseline" || v === "pricing" || v === "r-entry-ma5" ? "基础/定价"
      : "五段状态机(cycle*)";

const FINALISTS: Array<[string, ExitPolicy]> = [
  ["上限4日", { ...实盘口径, 到期: 4 }],
  ["上限5日", { ...实盘口径, 到期: 5 }],
  ["上限4日+破MA3", { ...实盘口径, 到期: 4, 破均线: 3 }],
];

function robustness(sliceOf: (i: number) => string | null, label: string) {
  const buckets = new Map<string, number[]>();
  rows.forEach((_, i) => { const k = sliceOf(i); if (k) { const a = buckets.get(k); if (a) a.push(i); else buckets.set(k, [i]); } });
  const REF = evaluate(实盘口径);
  console.log(`\n${label}`);
  console.log("　" + "切片".padEnd(16), "笔数".padStart(6),
    ...FINALISTS.map(([n]) => n.padStart(14)), "　| 参照期望".padStart(12));
  console.log("　" + "-".repeat(16 + 6 + FINALISTS.length * 14 + 12));
  for (const [k, idxs] of [...buckets].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (idxs.length < 40) continue;
    const refNets = idxs.map(i => REF.net[i]!).filter(x => x !== null);
    const cells = FINALISTS.map(([, pol]) => {
      const R = evaluate(pol);
      const ids = idxs.filter(i => R.net[i] !== null && REF.net[i] !== null);
      const r = clusterRobustT(R, REF, ids);
      return `${f(r.dMean, 3)}(t${f(r.t, 1)})`.padStart(14);
    });
    console.log("　" + k.padEnd(16), String(idxs.length).padStart(6), ...cells, f(mean(refNets), 3, 12));
  }
  console.log("　（每格 = 相对「实盘口径·无上限」的平均百分点差 + 聚类 t；保留 ≥40 笔的切片）");
}

robustness(i => rows[i].entryDate.slice(0, 4), "⑧-1 按入场年份：效应是不是某一年撑起来的");
robustness(i => FAMILY(rows[i].variant), "⑧-2 按变体家族：是不是某一族的票才成立");

/* ============ ⑨ 止损 × 目标：live 政策真正的参数空间 ============ */

/**
 * ⑦ 给出的结论是"时间上限别加"，那问题就回到原有两条线的取值上：
 *   止损 -10% 是 2026-09-27 从 -5% 放宽来的（当时发现收得太紧赔本），会不会还可以更宽？
 *   目标 +6% 也是从 8% 降下来的（当时发现目标设太远、多数单子最后被动离场），还会不会更好？
 * 两个方向都还是"拍出来"的数，没在这批样本上系统扫过。
 *
 * 只取**开仓计划里本来没有目标价**的那些笔：pricing 类变体自带结构位目标，
 * 混进来就分不清收益是来自政策的目标还是评估器的目标。
 */
const clean = rows.map((_, i) => i).filter(i => rows[i].targetPx === null && loaded[i] !== null);
const base: ExitPolicy = { 到期: 20, 目标: null, 硬止损: null, 不用计划止损: true, 移动止损: null, 破均线: null, 时间止损: null };

console.log(`\n⑨ 止损 × 目标 扫描（${clean.length} 笔无自带目标的样本，无时间上限）`);
console.log("　" + "止损\\目标".padEnd(10), ["无", "+4%", "+5%", "+6%", "+8%", "+10%"].map(s => s.padStart(13)).join(""));
console.log("　" + "-".repeat(10 + 6 * 13));
for (const stop of [-5, -8, -10, -12, -15, -20]) {
  const cells: string[] = [];
  for (const tgt of [null, 4, 5, 6, 8, 10]) {
    const pol: ExitPolicy = { ...base, 硬止损: stop, 目标: tgt };
    const ids = picker(rows.map((_, i) => i), evaluate(pol), evaluate(pol), clean);
    const nets = ids.map(i => evaluate(pol).net[i]!);
    const held = ids.map(i => evaluate(pol).held[i]!).filter((x): x is number => x !== null);
    cells.push(`${f(mean(nets), 3)}/${f(mean(nets) / mean(held), 2)}`.padStart(13));
  }
  console.log("　" + `${stop}%`.padEnd(10), cells.join(""));
}
{
  const row: string[] = [];
  for (const tgt of [null, 4, 5, 6, 8, 10]) {
    const pol: ExitPolicy = { ...base, 硬止损: null, 不用计划止损: true, 目标: tgt };
    const ids = picker(rows.map((_, i) => i), evaluate(pol), evaluate(pol), clean);
    const nets = ids.map(i => evaluate(pol).net[i]!);
    const held = ids.map(i => evaluate(pol).held[i]!).filter((x): x is number => x !== null);
    row.push(`${f(mean(nets), 3)}/${f(mean(nets) / mean(held), 2)}`.padStart(13));
  }
  console.log("　" + "不设止损".padEnd(10), row.join(""));
}
console.log("　（每格 = 期望%/笔 ÷ 期望/持有日；列 = 目标，行 = 止损）");

/* ============ ⑩ 在实盘口径上叠加：还能往上加一层吗 ============ */

/**
 * ⑤ 里 t 最高的单条规则是「第4日收盘仍亏就走」（t=2.74），但那是**影子口径**下的结果。
 * 实盘口径多了 +6% 目标与 -10% 止损，两条都可能抢在它前面触发，
 * 所以必须回到实盘口径上重测 —— 在错误的参照上做出来的结论不能搬运。
 */
const 现贷: ExitPolicy = { 到期: 20, 目标: 6, 硬止损: -10, 移动止损: null, 破均线: null, 时间止损: null };
table("⑩ 实盘口径上再叠一层，有没有增量？（参照 = 现行实盘口径）",
  [
    ["现行（-10%/+6%，无上限）", 现贷],
    ["+第3日仍亏走", { ...现贷, 时间止损: { 第几日: 3, 低于: 0 } }],
    ["+第4日仍亏走", { ...现贷, 时间止损: { 第几日: 4, 低于: 0 } }],
    ["+第6日仍亏走", { ...现贷, 时间止损: { 第几日: 6, 低于: 0 } }],
    ["+第4日浮亏超2%走", { ...现贷, 时间止损: { 第几日: 4, 低于: -2 } }],
    ["+破MA3", { ...现贷, 破均线: 3 }],
    ["+破MA5", { ...现贷, 破均线: 5 }],
    ["+第4日仍亏走 +破MA3", { ...现贷, 时间止损: { 第几日: 4, 低于: 0 }, 破均线: 3 }],
  ], 现贷, "叠加规则的**增量**，而不是它们单独有没有用 —— 单独有用不等于加上去还有用", clean);

/* ============ ⑪ 头号发现：两套离场口径根本不是一回事 ============ */

/**
 * 影子盘结算（settleShadow）跑的是：计划止损 + 5 日期满，**没有目标价**。
 * 而实盘卡片上的 账户纪律 是：-10% 止损（收盘确认）/ -15% 灾难位 / **+6% 清仓**，且**没有时间上限**。
 *
 * 两套规则在**同一批入场**上跑出来的结果，是变体评分的地基。
 * 如果地基那套就比实际执行的那套差，所有变体的分数都被系统性压低；
 * 而「自带目标价」的变体（结构位定价类）因为计划里有 target_px，在结算时**有目标可依**，
 * 剩下的变体却没有 —— 于是两批变体不是在同样的离场规则下比出来的。
 */
table("⑪ 影子结算口径 vs 实盘卡片口径（同一批入场）",
  [
    ["影子结算（5日期满，无目标）", 现行],
    ["实盘卡片（-10%/+6%，无上限）", 实盘口径],
  ], 现行,
  "这一张表不是改规则的建议，是对**计分方式**的质疑：两套口径在同样的入场上有系统性落差");

{
  const REF = evaluate(现行), LIVE = evaluate(实盘口径);
  const all = rows.map((_, i) => i).filter(i => REF.net[i] !== null && LIVE.net[i] !== null);
  console.log("\n⑪-补充 这个落差在每个子集上都成立吗");
  console.log("　" + "切片".padEnd(20), "笔数".padStart(6), "影子%".padStart(9), "实盘%".padStart(9), "Δ".padStart(9), "t(聚类)".padStart(9));
  for (const [k, mk] of [
    ["年份", (i: number) => rows[i].entryDate.slice(0, 4)],
    ["家族", (i: number) => FAMILY(rows[i].variant)],
  ] as Array<[string, (i: number) => string]>) {
    const buckets = new Map<string, number[]>();
    for (const i of all) { const key = mk(i); const a = buckets.get(key); if (a) a.push(i); else buckets.set(key, [i]); }
    for (const [key, ids] of [...buckets].sort((a, b) => a[0].localeCompare(b[0]))) {
      if (ids.length < 40) continue;
      const r = clusterRobustT(LIVE, REF, ids);
      console.log(`　${k} ${key}`.padEnd(20), String(ids.length).padStart(6),
        f(mean(ids.map(i => REF.net[i]!)), 3, 9), f(mean(ids.map(i => LIVE.net[i]!)), 3, 9),
        f(r.dMean, 3, 9), f(r.t, 2, 9));
    }
  }
}

/* 稳健性：⑩ 里若有一条正的，看它在年份与家族上是不是稳定 */
const CANDIDATES: Array<[string, ExitPolicy]> = [
  ["第4日仍亏走", { ...现贷, 时间止损: { 第几日: 4, 低于: 0 } }],
  ["破MA3", { ...现贷, 破均线: 3 }],
];
{
  const REF = evaluate(现贷);
  for (const [dimName, mk] of [
    ["年份", (i: number) => rows[i].entryDate.slice(0, 4)],
    ["家族", (i: number) => FAMILY(rows[i].variant)],
  ] as Array<[string, (i: number) => string]>) {
    const buckets = new Map<string, number[]>();
    for (const i of clean) { const k = mk(i); const a = buckets.get(k); if (a) a.push(i); else buckets.set(k, [i]); }
    console.log(`\n⑩-补充 稳健性（按${dimName}）：${CANDIDATES.map(([n]) => n).join(" / ")}`);
    console.log("　" + dimName.padEnd(16), "笔数".padStart(6), ...CANDIDATES.map(([n]) => n.padStart(16)), "　| 参照期望".padStart(12));
    for (const [k, idxs] of [...buckets].sort((a, b) => a[0].localeCompare(b[0]))) {
      if (idxs.length < 40) continue;
      const cells = CANDIDATES.map(([, pol]) => {
        const R = evaluate(pol);
        const ids = idxs.filter(i => R.net[i] !== null && REF.net[i] !== null);
        const r = clusterRobustT(R, REF, ids);
        return `${f(r.dMean, 3)}(t${f(r.t, 1)})`.padStart(16);
      });
      console.log("　" + k.padEnd(16), String(idxs.length).padStart(6), ...cells,
        f(mean(idxs.map(i => REF.net[i]!)), 3, 12));
    }
  }
}
