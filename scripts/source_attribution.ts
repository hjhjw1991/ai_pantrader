/**
 * 来源归因：把影子盘 19,100 条信号按「它是从哪来的 / 在什么状态下发的」拆开，
 * 逐组报每信号期望。
 *
 * 为什么必须做这一遍：离场规则（止盈 5%）已经落地，但它只是把已有的入场切细。
 * 偏移剖面早就证明入场是追高的——提前 4~15 日买 +1.05%、实际 −2.98%——
 * 止盈救不了烂入场，只能少亏一点。要真的把期望抬上去，得动「发什么信号」：
 * 哪个来源、哪种市场状态下发的信号是负贡献，就该把它关掉或降权。
 *
 * 与之前几次归因不同的地方（也是这次的纪律）：
 *   1. **样本 12,000+ 条**，不再用 39 条台账样本拍脑袋；
 *   2. 每组报**标准误与 t 值**。上次差点被 39 条里的"−8% 折让最优"骗到，
 *      就是因为没看显著性；n 大也要报，n 大不等于差异显著；
 *   3. **时间切分样本外**：样本内挑出来的维度必须在样本外复现才作数。
 *      按来源挑维度就是一次寻优，不做切分等于把选择偏差直接写进策略。
 *
 * 口径：D5 期满、限价低吸（min(开盘, 触发价)）、T+1（成交次日起才能离场）、
 * 未成交记 0 且留在分母里。离场用已落地的止盈 5%（DEFAULT_TAKE_PROFIT_PCT）。
 *
 * 用法：PANTRADER_DATA_DIR=... npx tsx scripts/source_attribution.ts [--limit=N] [--tp=5]
 */
import { loadCliEnv } from "@/lib/config";
loadCliEnv();
import { openDb } from "@/lib/db";
import {
  loadSampleBars, scorePolicy, replayTrade, type ClosedSample, type ExitRule, type SampleBars,
} from "@/lib/ledger/policy-lab";
import { adjFactorOn, tradingDayOffset } from "@/lib/ledger/reconcile";

const argNum = (k: string, d: number): number => {
  const m = process.argv.find(a => a.startsWith(`--${k}=`));
  return m ? Number(m.split("=")[1]) : d;
};
const limitArg = process.argv.find(a => a.startsWith("--limit="));
const limit = limitArg ? Number(limitArg.split("=")[1]) : null;
const TP = argNum("tp", 5);
const HORIZON = argNum("horizon", 5);
const WINDOW = argNum("window", 5);
const COST = argNum("cost", 0.15); // 双边成本，百分点

const db = openDb();

const rows = db.prepare(
  `SELECT id, variant_id, base_date, code, trigger_px, gear, stage, score, rr_ratio, size
   FROM shadow_pred ORDER BY base_date`
).all() as Array<{
  id: string; variant_id: string; base_date: string; code: string; trigger_px: number | null;
  gear: string | null; stage: string | null; score: number | null; rr_ratio: number | null;
  size: number | null;
}>;
const picked = limit ? rows.slice(0, limit) : rows;
console.log(`[attrib] 影子盘 ${rows.length} 条，本次取 ${picked.length} 条；口径 D${HORIZON} / 窗口 ${WINDOW} / 止盈 ${TP}% / 成本 ${COST}%`);

const samples: ClosedSample[] = [];
const meta = new Map<string, {
  variant: string; gear: string | null; stage: string | null;
  score: number | null; rr: number | null;
}>();
for (const r of picked) {
  if (r.trigger_px == null) continue;
  const end = tradingDayOffset(db, r.base_date, HORIZON);
  if (end == null) continue;
  samples.push({
    predId: r.id, code: r.code, action: "买入", horizon: HORIZON, base: r.base_date,
    entryPx: null, entryDate: null, holdFrom: null, horizonEnd: end,
    triggerPxAdj: r.trigger_px * adjFactorOn(db, r.code, r.base_date),
  });
  meta.set(r.id, {
    variant: r.variant_id, gear: r.gear, stage: r.stage, score: r.score, rr: r.rr_ratio,
  });
}
const all = loadSampleBars(db, samples);
console.log(`[attrib] 可重放 ${all.length} 条`);

const ENTRY = { discountPct: null, windowDays: WINDOW } as const;

/**
 * 每组跑一遍并报统计量。
 *
 * 扣成本的方式：只有**成交**的才付手续费，未成交记 0 的不付。
 * 全池摊 0.15% 会把不成交的也算进成本，等于凭空扣掉一笔没发生的钱，
 * 而"少成交"恰恰是某些组真正的价值所在。
 */
interface GroupStat {
  key: string;
  n: number;
  filled: number;
  fillRate: number;
  /** 每信号期望（百分点），未成交记 0，已扣成交的成本 */
  meanPct: number;
  sd: number;
  se: number;
  /** 相对 0 的 t 值。|t| > 2 才敢说这组不是噪音 */
  t: number;
}
function stat(key: string, group: readonly SampleBars[], exit: ExitRule): GroupStat {
  const pcts: number[] = [];
  let filled = 0;
  for (const sb of group) {
    const r = replayTrade(sb, ENTRY, exit);
    if (!r) continue;
    const p = r.triggered ? r.pct - COST : 0;
    pcts.push(p);
    if (r.triggered) filled++;
  }
  const n = pcts.length;
  const mean = n === 0 ? Number.NaN : pcts.reduce((a, b) => a + b, 0) / n;
  const variance = n < 2 ? Number.NaN
    : pcts.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1);
  const sd = Number.isNaN(variance) ? Number.NaN : Math.sqrt(variance);
  const se = Number.isNaN(sd) || n === 0 ? Number.NaN : sd / Math.sqrt(n);
  return {
    key, n, filled, fillRate: n === 0 ? Number.NaN : filled / n,
    meanPct: mean, sd, se, t: Number.isNaN(se) || se === 0 ? Number.NaN : mean / se,
  };
}

function report(title: string, groups: Array<[string, SampleBars[]]>, exit: ExitRule): void {
  console.log(`\n[attrib] ${title}`);
  console.log("  分组".padEnd(16) + "   n   成交率   每信号期望     SE     t");
  const stats = groups.map(([k, g]) => stat(k, g, exit)).filter(s => s.n >= 20);
  for (const s of stats) {
    console.log(
      `  ${s.key.padEnd(14)}${String(s.n).padStart(5)}  ${(s.fillRate * 100).toFixed(0).padStart(4)}%` +
      `  ${s.meanPct.toFixed(3).padStart(8)}%  ${s.se.toFixed(3).padStart(6)}` +
      `  ${s.t.toFixed(2).padStart(6)}`
    );
  }
  const dropped = groups.filter(([, g]) => g.length >= 20 && g.length < 20).length;
  if (dropped > 0) console.log(`  （另有 ${dropped} 组样本不足 20 条，不报）`);
}

// ── 全池基线 ──────────────────────────────────────────────────────────────
const EXIT: ExitRule = { takeProfitPct: TP, stopPct: null, trailPct: null };
const base = stat("全池", all, EXIT);
console.log(
  `\n[attrib] 全池基线：每信号 ${base.meanPct.toFixed(3)}%  SE ${base.se.toFixed(3)}  t ${base.t.toFixed(2)}` +
  `  成交率 ${(base.fillRate * 100).toFixed(0)}%  n=${base.n}`
);

// ── 时间切分 ──────────────────────────────────────────────────────────────
const byDate = [...all].sort((a, b) => a.sample.base.localeCompare(b.sample.base));
const cut = Math.floor(byDate.length * 0.7);
const isSet = byDate.slice(0, cut);
const oosSet = byDate.slice(cut);
console.log(
  `[attrib] 时间切分：样本内 ${isSet.length}（至 ${isSet[isSet.length - 1].sample.base}），` +
  `样本外 ${oosSet.length}（${oosSet[0].sample.base} 起）`
);
const isBase = stat("样本内", isSet, EXIT);
const oosBase = stat("样本外", oosSet, EXIT);
console.log(`  样本内 ${isBase.meanPct.toFixed(3)}%  样本外 ${oosBase.meanPct.toFixed(3)}%`);

// ── 分组维度 ──────────────────────────────────────────────────────────────
const groupBy = (set: readonly SampleBars[], f: (sb: SampleBars) => string | null): Array<[string, SampleBars[]]> => {
  const m = new Map<string, SampleBars[]>();
  for (const sb of set) {
    const k = f(sb);
    if (k == null) continue;
    const hit = m.get(k);
    if (hit) hit.push(sb); else m.set(k, [sb]);
  }
  return [...m.entries()];
};
const metaOf = (sb: SampleBars) => meta.get(sb.sample.predId);

report("情绪周期阶段 stage", groupBy(all, sb => metaOf(sb)?.stage ?? null), EXIT);
report("仓位档 gear", groupBy(all, sb => metaOf(sb)?.gear ?? null), EXIT);
report("策略变体 variant", groupBy(all, sb => metaOf(sb)?.variant ?? null), EXIT);

/**
 * 动量分位：基准日收盘相对前 5 / 10 个交易日的涨幅，按样本内分位切成 5 档。
 *
 * 这是"追高"的直接度量，也是上一次（n=39）放弃的那个闸门。现在 n 上万，
 * 该重新问一遍。分位切点用**样本内**算、再用到样本外，避免拿未来数据切档。
 */
function quantileBuckets(
  set: readonly SampleBars[], pick: (sb: SampleBars) => number | null
): (sb: SampleBars) => string | null {
  const vals = isSet.map(pick).filter((v): v is number => v != null).sort((a, b) => a - b);
  if (vals.length < 50) return () => null;
  const qs = [0.2, 0.4, 0.6, 0.8].map(p => vals[Math.floor(p * (vals.length - 1))]);
  return (sb) => {
    const v = pick(sb);
    if (v == null) return null;
    let i = 0;
    while (i < qs.length && v > qs[i]) i++;
    return `Q${i + 1}`;
  };
}

for (const [label, pick] of [
  ["基准日前 5 日涨幅分位", (sb: SampleBars) => sb.ret5],
  ["基准日前 10 日涨幅分位", (sb: SampleBars) => sb.ret10],
] as Array<[string, (sb: SampleBars) => number | null]>) {
  const bucket = quantileBuckets(all, pick);
  report(label, groupBy(all, bucket), EXIT);
}

const scoreBucket = quantileBuckets(all, sb => metaOf(sb)?.score ?? null);
if (metaOf(all[0])?.score != null) {
  report("信号打分 score 分位", groupBy(all, scoreBucket), EXIT);
}
const rrBucket = quantileBuckets(all, sb => metaOf(sb)?.rr ?? null);
if (metaOf(all[0])?.rr != null) {
  report("盈亏比 rr 分位", groupBy(all, rrBucket), EXIT);
}

// ── 每个维度在样本内/样本外各报一遍：只有两边同向才作数 ──────────────────
console.log("\n[attrib] 样本内/样本外一致性（两边同向且样本外不塌，才算真维度）");
console.log("  维度".padEnd(18) + "分组".padEnd(8) + "样本内".padStart(9) + "样本外".padStart(9) + "  判定");
for (const [dim, f] of [
  ["stage", (sb: SampleBars) => metaOf(sb)?.stage ?? null],
  ["gear", (sb: SampleBars) => metaOf(sb)?.gear ?? null],
  ["variant", (sb: SampleBars) => metaOf(sb)?.variant ?? null],
  ["ret5分位", quantileBuckets(all, sb => sb.ret5)],
  ["ret10分位", quantileBuckets(all, sb => sb.ret10)],
] as Array<[string, (sb: SampleBars) => string | null]>) {
  const isGroups = groupBy(isSet, f);
  const oosGroups = groupBy(oosSet, f);
  const oosMap = new Map(oosGroups.map(([k, g]) => [k, g]));
  for (const [k, g] of isGroups) {
    if (g.length < 100) continue;
    const og = oosMap.get(k);
    if (!og || og.length < 50) continue;
    const a = stat(k, g, EXIT);
    const b = stat(k, og, EXIT);
    const sameSign = Math.sign(a.meanPct) === Math.sign(b.meanPct);
    const verdict = !sameSign ? "❌ 反向"
      : b.meanPct >= oosBase.meanPct ? "✅ 优（可加权）"
      : b.meanPct < 0 ? "⚠️ 负贡献（可剔除）" : "－ 中性";
    console.log(
      `  ${dim.padEnd(16)}${k.padEnd(8)}${a.meanPct.toFixed(3).padStart(8)}%${b.meanPct.toFixed(3).padStart(8)}%  ${verdict}`
    );
  }
}

// ── 剔除实验：拿掉某一组之后全池期望变多少 ───────────────────────────────
console.log("\n[attrib] 剔除实验（样本外）：拿掉该组后全池期望");
console.log("  维度".padEnd(18) + "分组".padEnd(8) + "样本外".padStart(9) + "全池".padStart(9) + "  增量");
for (const [dim, f] of [
  ["stage", (sb: SampleBars) => metaOf(sb)?.stage ?? null],
  ["gear", (sb: SampleBars) => metaOf(sb)?.gear ?? null],
  ["ret5分位", quantileBuckets(all, sb => sb.ret5)],
] as Array<[string, (sb: SampleBars) => string | null]>) {
  const oosGroups = groupBy(oosSet, f);
  for (const [k, g] of oosGroups) {
    if (g.length < 50) continue;
    const drop = new Set(g.map(x => x.sample.predId));
    const rest = oosSet.filter(x => !drop.has(x.sample.predId));
    const s = stat(`去掉${k}`, rest, EXIT);
    console.log(
      `  ${dim.padEnd(16)}${k.padEnd(8)}${s.meanPct.toFixed(3).padStart(8)}%` +
      `${oosBase.meanPct.toFixed(3).padStart(8)}%  ${(s.meanPct - oosBase.meanPct >= 0 ? "+" : "")}` +
      `${(s.meanPct - oosBase.meanPct).toFixed(3)}pp`
    );
  }
}

db.close();
