/**
 * 策略实验室（只读，不改库）。
 *
 * 用台账里已经发生过的仓位，离线重放入场/离场规则，回答"怎么改能提高期望"。
 * 看四件事，缺一个都不能下结论：
 *
 *   1. 台账现状与「纯期满」基线 —— 现在这套值多少；
 *   2. 偏移剖面 —— 提前买 / 实际买 / 推迟买各值多少，判断是不是追高；
 *   3. 随机入场对照 —— 真实成绩落在零假设分布的什么分位。
 *      **这一条是能不能信其余各条的前提**：分位在 0.5 附近说明入场本身没有 alpha，
 *      网格里那个"最好"多半是挑出来的运气；
 *   4. 入场折让 × 触发窗口 × 离场规则网格 —— 真要改就改这些旋钮。
 *
 * 用法：PANTRADER_DATA_DIR=... npx tsx scripts/policy_lab.ts [--trials=300] [--window=15]
 */
import { loadCliEnv } from "@/lib/config";
loadCliEnv();
import { openDb } from "@/lib/db";
import {
  gridSearch, loadLongSamples, loadSampleBars, loocv, offsetProfile, policyGridSearch,
  momentumGate, randomControl, replayTrade, scoreRule,
  type EntryRule as EntryRule2, type ExitRule, type RuleGrid,
} from "@/lib/ledger/policy-lab";

const arg = (k: string, d: number): number => {
  const m = process.argv.find(a => a.startsWith(`--${k}=`));
  return m ? Number(m.split("=")[1]) : d;
};
const trials = arg("trials", 300);
const windowDays = arg("window", 15);

const db = openDb();
const samples = loadLongSamples(db);
console.log(`[lab] 看涨方向已成仓位 ${samples.length} 条`);

const ledger = db.prepare(
  `SELECT AVG(o.actual_pct) m, COUNT(*) n
   FROM prediction p JOIN outcome o ON o.pred_id = p.id
   WHERE o.verdict != '作废' AND o.entry_px IS NOT NULL AND o.dirty_reason IS NULL`
).get() as { m: number | null; n: number };
console.log(`[lab] 台账现状（全部动作）每信号平均 ${ledger.m?.toFixed(2) ?? "-"}%  n=${ledger.n}`);

const hold = scoreRule(db, samples, { takeProfitPct: null, stopPct: null, trailPct: null });
console.log(
  `[lab] 基线「纯期满」每信号平均 ${hold.meanPct.toFixed(2)}%  胜率 ${(hold.winRate * 100).toFixed(1)}%  n=${hold.n}`
);

// ── 1. 偏移剖面：是不是追高 ───────────────────────────────────────────────
console.log("\n[lab] 偏移剖面（入场日相对实际入场日前后平移，纯期满口径）");
const prof = offsetProfile(db, samples, { takeProfitPct: null, stopPct: null, trailPct: null }, windowDays);
for (const p of prof) {
  const bar = (p.meanPct >= 0 ? "+" : "") + p.meanPct.toFixed(2);
  const mark = p.offset === 0 ? "  <== 实际入场日" : "";
  console.log(
    `  ${String(p.offset).padStart(3)}  n=${String(p.n).padStart(2)}  ${bar.padStart(7)}%  ` +
    `${"#".repeat(Math.max(0, Math.round(p.meanPct * 4)))}${mark}`
  );
}
const atZero = prof.find(p => p.offset === 0);
if (atZero) {
  const mean = (xs: typeof prof) => xs.reduce((a, b) => a + b.meanPct, 0) / (xs.length || 1);
  const before = mean(prof.filter(p => p.offset < 0));
  const after = mean(prof.filter(p => p.offset > 0));
  console.log(`  提前买均值 ${before.toFixed(2)}%  实际 ${atZero.meanPct.toFixed(2)}%  推迟买均值 ${after.toFixed(2)}%`);
  console.log(
    before > atZero.meanPct
      ? "  ⚠ 提前买系统性更好 → 推荐发出时票已经涨完，我们买在尾巴上（追高）"
      : "  提前买并不更好 → 不是追高，问题在别处"
  );
}

// ── 2. 离场规则网格 ───────────────────────────────────────────────────────
const grid: RuleGrid = {
  takeProfitPct: [null, 3, 5, 8, 10, 15, 20],
  stopPct: [null, 3, 5, 7, 10, 15],
  trailPct: [null, 3, 5, 7, 10],
};
const res = gridSearch(db, samples, grid);
const b = res.best;
console.log(`\n[lab] 离场网格共 ${res.scores.length} 组，最优点：`);
console.log(
  `  止盈 ${fmt(b.rule.takeProfitPct)}  止损 ${fmt(b.rule.stopPct)}  移动止损 ${fmt(b.rule.trailPct)}` +
  ` → 每信号 ${b.meanPct.toFixed(2)}%  胜率 ${(b.winRate * 100).toFixed(1)}%`
);
console.log(
  `  邻域均值 ${res.neighbourMeanPct.toFixed(2)}%  sharpness=${res.sharpness.toFixed(2)}` +
  `  ${res.overfitRisk ? "⚠ 孤峰，过拟合风险高" : "（峰形平缓）"}`
);
console.log(`  选择偏差：${res.selection.note}`);

console.log("\n[lab] 单轴敏感度（该取值下所有组合的平均收益，看的是稳不稳不是最好多好）：");
for (const axis of ["takeProfitPct", "stopPct", "trailPct"] as const) {
  const cells = grid[axis].map(v => {
    const sub = res.scores.filter(s => s.rule[axis] === v);
    const mean = sub.reduce((a, s) => a + s.meanPct, 0) / (sub.length || 1);
    return `${fmt(v)}=${mean.toFixed(2)}%`;
  });
  console.log(`  ${axis}: ${cells.join("  ")}`);
}

// ── 3. 随机入场对照 ───────────────────────────────────────────────────────
console.log(`\n[lab] 随机入场对照（trials=${trials}, window=±${windowDays} 交易日）`);
for (const [label, rule] of [
  ["基线 纯期满", { takeProfitPct: null, stopPct: null, trailPct: null } as ExitRule],
  ["离场最优点", b.rule],
] as Array<[string, ExitRule]>) {
  const c = randomControl(db, samples, rule, { trials, windowDays });
  console.log(
    `  ${label}: 真实 ${c.actualMeanPct.toFixed(2)}%  零假设均值 ${c.nullMean.toFixed(2)}%` +
    `  分位 ${(c.percentile * 100).toFixed(1)}%` +
    `  ${c.percentile >= 0.9 ? "✅ 显著" : c.percentile >= 0.75 ? "（偏前但不够显著）" : "❌ 与随机无异"}`
  );
}

// ── 4. 入场折让 × 窗口 × 离场 ─────────────────────────────────────────────
console.log("\n[lab] 完整策略网格：入场折让 × 触发窗口 × 离场");
const exits: ExitRule[] = [
  { takeProfitPct: null, stopPct: null, trailPct: null },
  { takeProfitPct: 8, stopPct: null, trailPct: null },
  { takeProfitPct: null, stopPct: 8, trailPct: null },
  { takeProfitPct: null, stopPct: null, trailPct: 5 },
  { takeProfitPct: 8, stopPct: 8, trailPct: null },
];
const all = loadSampleBars(db, samples);
const DISCOUNTS: Array<number | null> = [null, 0, 2, 3, 5, 8, 10, 15];
const WINDOWS = [1, 3, 5];
const pol = policyGridSearch(all, DISCOUNTS, WINDOWS, exits);
console.log(`  共 ${pol.scores.length} 组，前 15 组：`);
for (const s of [...pol.scores].sort((x, y) => y.meanPct - x.meanPct).slice(0, 15)) {
  console.log(
    `  折让 ${String(s.entry.discountPct).padStart(2)}%  窗口 ${s.entry.windowDays}天  ` +
    `止盈 ${fmt(s.exit.takeProfitPct)} 止损 ${fmt(s.exit.stopPct)} 移动 ${fmt(s.exit.trailPct)}` +
    ` → 每信号 ${s.meanPct.toFixed(2)}%  成交率 ${(s.fillRate * 100).toFixed(0)}%` +
    `  已成交均值 ${s.meanPctFilled.toFixed(2)}%`
  );
}
console.log(`  选择偏差：${pol.selection.note}`);

console.log("\n[lab] 折让单轴（固定窗口 5 天、纯期满）：");
for (const d of [0, 2, 3, 5, 8, 10, 15]) {
  const s = pol.scores.find(
    x => x.entry.discountPct === d && x.entry.windowDays === 5
      && x.exit.takeProfitPct == null && x.exit.stopPct == null && x.exit.trailPct == null
  );
  if (s) {
    console.log(
      `  折让 ${String(d).padStart(2)}% → 每信号 ${s.meanPct.toFixed(2)}%  ` +
      `成交率 ${(s.fillRate * 100).toFixed(0)}%（${s.filled}/${s.n}）  已成交均值 ${s.meanPctFilled.toFixed(2)}%`
    );
  }
}

// ── 5. 动量闸门：直接拦掉已经涨完的信号 ────────────────────────────────────
console.log("\n[lab] 入场前动量 vs 实际收益（折让 0%、纯期满口径，看追高的形状）");
const pairs = all.map(x => {
  const r = replayTrade(x, { discountPct: 0, windowDays: 5 }, { takeProfitPct: null, stopPct: null, trailPct: null });
  return { code: x.sample.code, ret5: x.ret5, pct: r?.pct ?? 0 };
}).filter(x => x.ret5 != null).sort((a, b) => (a.ret5 ?? 0) - (b.ret5 ?? 0));
for (const x of pairs) {
  console.log(`  ${x.code}  近5日 ${x.ret5!.toFixed(1).padStart(6)}%  →  收益 ${x.pct.toFixed(2).padStart(7)}%`);
}
const corr = pearson(pairs.map(x => x.ret5 ?? 0), pairs.map(x => x.pct));
console.log(`  相关系数 ${corr.toFixed(3)}（负 = 涨得越多后面越差，即追高惩罚有依据）`);

console.log("\n[lab] 动量闸门剖面（折让 8% / 窗口 3 天 / 止盈 8% / 止损 8%）");
const GATE: EntryRule2 = { discountPct: 8, windowDays: 3 };
const GEXIT: ExitRule = { takeProfitPct: 8, stopPct: 8, trailPct: null };
for (const lb of [5, 10] as const) {
  const THRESH: Array<number | null> = [null, 40, 30, 20, 15, 10, 5, 0, -5];
  const g = momentumGate(all, THRESH, GATE, GEXIT, lb);
  console.log(`  近${lb}日涨幅阈值：`);
  for (const x of g) {
    console.log(
      `    ${x.threshold == null ? "不过滤" : ("≤" + x.threshold + "%").padStart(6)}` +
      `  保留 ${String(x.kept).padStart(2)} 条  每信号 ${x.meanPct.toFixed(2).padStart(6)}%  成交率 ${(x.fillRate * 100).toFixed(0)}%`
    );
  }
}

// ── 6. 留一法交叉验证 ─────────────────────────────────────────────────────
console.log("\n[lab] 留一法交叉验证（每折在其余样本上选参数，再用到没见过的那个上）");
const cv = loocv(all, DISCOUNTS, WINDOWS, exits);
console.log(
  `  泛化期望 ${cv.meanPct.toFixed(2)}%  胜率 ${(cv.winRate * 100).toFixed(1)}%` +
  `  成交率 ${(cv.fillRate * 100).toFixed(0)}%  n=${cv.folds.length}`
);
console.log(`  对照：样本内最优点 ${pol.best.meanPct.toFixed(2)}%  → 泛化后 ${cv.meanPct.toFixed(2)}%`);
console.log("  参数稳定性（25 折各选出了什么）：");
for (const c of cv.chosenCounts.slice(0, 6)) {
  console.log(
    `    ${String(c.times).padStart(2)} 折选中：折让 ${c.entry.discountPct}% 窗口 ${c.entry.windowDays}天 ` +
    `止盈 ${fmt(c.exit.takeProfitPct)} 止损 ${fmt(c.exit.stopPct)} 移动 ${fmt(c.exit.trailPct)}`
  );
}

db.close();

function pearson(xs: number[], ys: number[]): number {
  const n = Math.min(xs.length, ys.length);
  if (n < 2) return Number.NaN;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx, dy = ys[i] - my;
    sxy += dx * dy; sxx += dx * dx; syy += dy * dy;
  }
  return sxx === 0 || syy === 0 ? Number.NaN : sxy / Math.sqrt(sxx * syy);
}

function fmt(v: number | null): string {
  return v == null ? "  -" : String(v).padStart(3);
}
