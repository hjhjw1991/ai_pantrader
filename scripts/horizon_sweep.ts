/**
 * 持仓期扫描：同一批信号，持有几天最划算。
 *
 * 为什么跑这一遍：持仓期在这套系统里一直是个**拍出来的常数**（D5），
 * 从来没被当成可寻优的参数问过。而它同时决定两件事——
 *   1. 收益：趋势能不能走完；
 *   2. 资金周转：槽位有限时，占 3 天和占 20 天是两笔完全不同的生意。
 * 只看"每信号期望"会把我们推向"持有越久赚越多"的错觉，所以这里同时报
 * **每占用交易日的收益**（总收益 / 总占用天数），那才是槽位约束下的产能。
 *
 * 口径要点：
 *   - 用**同一批**信号跑全部持仓期（都要求后续 MAX_H 个交易日有行情），
 *     否则每个持仓期筛掉不同的样本，比出来的差异里混着样本差异；
 *   - 时间切分 7:3，样本内挑参数、样本外验收；
 *   - 扣双边成本，只扣成交的笔；
 *   - 触发窗口固定 5 天、折让用台账原触发价，只有持仓期这个轴在动。
 *
 * 用法：PANTRADER_DATA_DIR=... npx tsx scripts/horizon_sweep.ts [--maxh=20] [--cost=0.15]
 */
import { loadCliEnv } from "@/lib/config";
loadCliEnv();
import { openDb } from "@/lib/db";
import {
  loadSampleBars, replayTrade, type ClosedSample, type ExitRule, type SampleBars,
} from "@/lib/ledger/policy-lab";
import { adjFactorOn, tradingDayOffset } from "@/lib/ledger/reconcile";

const argNum = (k: string, d: number): number => {
  const m = process.argv.find(a => a.startsWith(`--${k}=`));
  return m ? Number(m.split("=")[1]) : d;
};
/**
 * 期满日 = 基准日 + MAX_H 个交易日。**这个数决定触发窗口有多长**：
 * 台账里成交只能发生在期满日之前，所以 MAX_H 同时是"最多等几天"。
 * 默认 5 = 现行配置；给 20 是在问"如果把期满日放宽到 20 天会怎样"。
 */
const MAX_H = argNum("maxh", 5);
const COST = argNum("cost", 0.15);
const WINDOW = argNum("window", 5);

const db = openDb();

const rows = db.prepare(
  `SELECT id, base_date, code, trigger_px FROM shadow_pred ORDER BY base_date`
).all() as Array<{ id: string; base_date: string; code: string; trigger_px: number | null }>;

const samples: ClosedSample[] = [];
for (const r of rows) {
  if (r.trigger_px == null) continue;
  /**
   * 一律按 MAX_H 取行情，再用 ExitRule.maxHoldDays 切短 —— 这样每个持仓期
   * 面对的是**同一批**信号。若按各自的 horizon 取，D3 会比 D20 多留一批
   * 近期信号，两组就不是同一道题了。
   */
  const end = tradingDayOffset(db, r.base_date, MAX_H);
  if (end == null) continue;
  samples.push({
    predId: r.id, code: r.code, action: "买入", horizon: MAX_H, base: r.base_date,
    entryPx: null, entryDate: null, holdFrom: null, horizonEnd: end,
    triggerPxAdj: r.trigger_px * adjFactorOn(db, r.code, r.base_date),
  });
}
const all = loadSampleBars(db, samples);
console.log(
  `[horizon] 影子盘 ${rows.length} 条 → 可重放（需后续 ${MAX_H} 个交易日行情）${all.length} 条；` +
  `成本 ${COST}%，触发窗口 ${WINDOW} 天`
);

const byDate = [...all].sort((a, b) => a.sample.base.localeCompare(b.sample.base));
const cut = Math.floor(byDate.length * 0.7);
const isSet = byDate.slice(0, cut);
const oosSet = byDate.slice(cut);
console.log(
  `[horizon] 时间切分：样本内 ${isSet.length}（至 ${isSet[isSet.length - 1].sample.base}），` +
  `样本外 ${oosSet.length}（${oosSet[0].sample.base} 起）`
);

interface Stat {
  n: number; filled: number; fillRate: number;
  /** 每信号期望（百分点），未成交记 0，成交的扣成本 */
  meanPct: number;
  /** 每占用交易日收益（百分点） */
  pctPerDay: number;
  avgHoldDays: number;
  se: number;
}
function stat(set: readonly SampleBars[], exit: ExitRule): Stat {
  const pcts: number[] = [];
  let filled = 0;
  let days = 0;
  for (const sb of set) {
    const r = replayTrade(sb, { discountPct: null, windowDays: WINDOW }, exit);
    if (!r) continue;
    pcts.push(r.triggered ? r.pct - COST : 0);
    if (r.triggered) { filled++; days += r.holdDays; }
  }
  const n = pcts.length;
  const mean = n === 0 ? Number.NaN : pcts.reduce((a, b) => a + b, 0) / n;
  const varr = n < 2 ? Number.NaN : pcts.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1);
  const se = Number.isNaN(varr) || n === 0 ? Number.NaN : Math.sqrt(varr / n);
  return {
    n, filled, fillRate: n === 0 ? Number.NaN : filled / n, meanPct: mean,
    pctPerDay: days === 0 ? Number.NaN : (mean * n) / days,
    avgHoldDays: filled === 0 ? Number.NaN : days / filled,
    se,
  };
}

/**
 * 时间止损档位。上限就是 MAX_H —— 超过期满日的档位没有意义，
 * 台账不会让仓位活到期满日之后。
 */
const HOLDS: Array<number | null> =
  Array.from({ length: MAX_H }, (_, i) => i + 1).concat([null]);
const TPS: Array<number | null> = [null, 3, 4, 5, 6, 8, 10, 15];

console.log("\n[horizon] 单轴：持仓期（不止盈）");
console.log("  持仓   每信号(内)  每信号(外)   每日(外)  实际占用   成交率");
for (const h of HOLDS) {
  const a = stat(isSet, { takeProfitPct: null, stopPct: null, trailPct: null, maxHoldDays: h });
  const b = stat(oosSet, { takeProfitPct: null, stopPct: null, trailPct: null, maxHoldDays: h });
  console.log(
    `  D${String(h ?? MAX_H).padStart(2)}  ${a.meanPct.toFixed(3).padStart(8)}%  ${b.meanPct.toFixed(3).padStart(9)}%` +
    `  ${b.pctPerDay.toFixed(3).padStart(7)}%  ${b.avgHoldDays.toFixed(2).padStart(6)}天  ${(b.fillRate * 100).toFixed(0).padStart(4)}%`
  );
}

console.log("\n[horizon] 持仓期 × 止盈（报样本外，按每信号期望与每日期望各排一次）");
console.log("  持仓   止盈   每信号(内)  每信号(外)   每日(外)  占用   t(外)");
interface Row { h: number | null; tp: number | null; is: Stat; oos: Stat }
const rows2: Row[] = [];
for (const h of HOLDS) {
  for (const tp of TPS) {
    const exit: ExitRule = { takeProfitPct: tp, stopPct: null, trailPct: null, maxHoldDays: h };
    rows2.push({ h, tp, is: stat(isSet, exit), oos: stat(oosSet, exit) });
  }
}
for (const r of rows2) {
  console.log(
    `  D${String(r.h ?? MAX_H).padStart(2)}  ${String(r.tp ?? "不设").padStart(4)}` +
    `  ${r.is.meanPct.toFixed(3).padStart(8)}%  ${r.oos.meanPct.toFixed(3).padStart(9)}%` +
    `  ${r.oos.pctPerDay.toFixed(3).padStart(7)}%  ${r.oos.avgHoldDays.toFixed(2).padStart(5)}` +
    `  ${(r.oos.se > 0 ? r.oos.meanPct / r.oos.se : Number.NaN).toFixed(2).padStart(5)}`
  );
}

const topByPct = [...rows2].sort((a, b) => b.oos.meanPct - a.oos.meanPct).slice(0, 6);
const topByDay = [...rows2].sort((a, b) => b.oos.pctPerDay - a.oos.pctPerDay).slice(0, 6);
console.log("\n[horizon] 样本外 每信号期望 Top6：");
for (const r of topByPct) {
  console.log(
    `  D${r.h} 止盈${r.tp ?? "不设"}  外 ${r.oos.meanPct.toFixed(3)}%  内 ${r.is.meanPct.toFixed(3)}%` +
    `  每日 ${r.oos.pctPerDay.toFixed(3)}%  SE ${r.oos.se.toFixed(3)}`
  );
}
console.log("[horizon] 样本外 每日期望 Top6：");
for (const r of topByDay) {
  console.log(
    `  D${r.h} 止盈${r.tp ?? "不设"}  每日 ${r.oos.pctPerDay.toFixed(3)}%  每信号 ${r.oos.meanPct.toFixed(3)}%` +
    `  占用 ${r.oos.avgHoldDays.toFixed(2)}天  内 ${r.is.meanPct.toFixed(3)}%`
  );
}

/** 现行口径 D5 + 止盈 5% 作为对照基线 */
const cur: ExitRule = { takeProfitPct: 5, stopPct: null, trailPct: null, maxHoldDays: 5 };
const curIs = stat(isSet, cur);
const curOos = stat(oosSet, cur);
console.log(
  `\n[horizon] 现行口径（D5 + 止盈5%）：样本内 ${curIs.meanPct.toFixed(3)}%  样本外 ${curOos.meanPct.toFixed(3)}%` +
  `  每日 ${curOos.pctPerDay.toFixed(3)}%  占用 ${curOos.avgHoldDays.toFixed(2)}天  SE ${curOos.se.toFixed(3)}`
);

/**
 * ── 分段稳定性 ──────────────────────────────────────────────────────────
 *
 * 上面那张表不能用：持仓期这个轴在样本内外的排序**整个反过来**
 * （D3 内 −0.086% / 外 +0.444%，D20 内 +0.488% / 外 +0.117%）。
 * 那不是"参数好"，那是两段时间的市场状态不一样——拿最后一段当裁判，
 * 选出来的是"哪套参数刚好适合最近这段行情"。
 *
 * 所以改成按半年切开，每个参数在**每一段**上都跑一遍，看的是：
 *   均值（整体水平）、最差段（下行保护）、为正的段数（是不是普遍成立）。
 * 只在最后一段赢的，在这里会露馅。
 */
const segOf = (d: string): string => {
  const y = d.slice(0, 4);
  const m = Number(d.slice(5, 7));
  return `${y}H${m <= 6 ? 1 : 2}`;
};
const segMap = new Map<string, SampleBars[]>();
for (const sb of all) {
  const k = segOf(sb.sample.base);
  const hit = segMap.get(k);
  if (hit) hit.push(sb); else segMap.set(k, [sb]);
}
/** 样本太少的段不进裁判席：几百条算出来的期望本身就有 ±0.3pp 的噪音 */
const segments = [...segMap.entries()].filter(([, g]) => g.length >= 300)
  .sort((a, b) => a[0].localeCompare(b[0]));
console.log(
  `\n[horizon] 分段稳定性（每段 ≥300 条）：${segments.map(([k, g]) => `${k}(${g.length})`).join("  ")}`
);

const CANDIDATES: Array<{ label: string; exit: ExitRule }> = [];
for (const h of [1, 2, 3, 4, 5]) {
  for (const tp of [null, 3, 4, 5, 6, 8, 10]) {
    for (const sl of [null, 5, 8]) {
      CANDIDATES.push({
        label: `D${h}/TP${tp ?? "-"}/SL${sl ?? "-"}`,
        exit: { takeProfitPct: tp, stopPct: sl, trailPct: null, maxHoldDays: h },
      });
    }
  }
}
CANDIDATES.push({ label: "现行D5/TP5", exit: cur });

console.log("\n[horizon] 各段每信号期望（百分点）：");
console.log("  参数".padEnd(14) + segments.map(([k]) => k.padStart(8)).join("") + "   加权均值  最差段  为正段");
/**
 * 均值一律**按段样本量加权**。
 *
 * 等权会把 381 条的 2023H2（影子盘刚上线的那一个半月，正好撞上 2024-01 暴跌）
 * 和 2601 条的 2025H2 放在同一权重上 —— 一个只占 3% 样本的极端段，
 * 就能把"分段均值"拽走 1pp 以上。等权分段平均是另一种形式的过拟合。
 */
const totalN = segments.reduce((a, [, g]) => a + g.length, 0);
const summary: Array<{
  label: string; exit: ExitRule; wMean: number; min: number; pos: number; perDay: number;
}> = [];
for (const c of CANDIDATES) {
  const per = segments.map(([, g]) => stat(g, c.exit));
  const means = per.map(s => s.meanPct);
  const wMean = per.reduce((a, s, i) => a + s.meanPct * segments[i][1].length, 0) / totalN;
  const min = Math.min(...means);
  const pos = means.filter(m => m > 0).length;
  const days = per.reduce((a, s) => a + (Number.isFinite(s.avgHoldDays) ? s.avgHoldDays * s.filled : 0), 0);
  const gain = per.reduce((a, s) => a + s.meanPct * s.n, 0);
  summary.push({ label: c.label, exit: c.exit, wMean, min, pos, perDay: days === 0 ? Number.NaN : gain / days });
  console.log(
    `  ${c.label.padEnd(12)}` + means.map(m => m.toFixed(3).padStart(8)).join("") +
    `  ${wMean.toFixed(3).padStart(7)} ${min.toFixed(3).padStart(7)}  ${pos}/${segments.length}`
  );
}
console.log("\n[horizon] 按加权均值排序（同时看最差段与每日期望）：");
console.log("  参数".padEnd(14) + "  加权均值   最差段   为正段   每日期望");
for (const s of [...summary].sort((a, b) => b.wMean - a.wMean)) {
  console.log(
    `  ${s.label.padEnd(12)}${s.wMean.toFixed(3).padStart(8)}% ${s.min.toFixed(3).padStart(8)}%` +
    `  ${s.pos}/${segments.length}    ${s.perDay.toFixed(3).padStart(6)}%`
  );
}

/**
 * ── 成本敏感性 ──────────────────────────────────────────────────────────
 *
 * 持仓越短，同一笔固定成本被摊在越少的收益上 —— 上面"D2 每日期望 4 倍于 D5"
 * 的结论，在真实滑点面前可能整个翻转。这里把成本从 0.05% 拉到 0.5% 双边，
 * 看结论在哪个成本上失效。**没做这一步之前不配改配置。**
 */
console.log("\n[horizon] 成本敏感性（加权每信号期望 / 每日期望，百分点）");
const COSTS = [0.05, 0.15, 0.3, 0.5];
console.log("  参数".padEnd(14) + COSTS.map(c => `${c}%`.padStart(16)).join(""));
for (const s of [...summary].sort((a, b) => b.wMean - a.wMean)) {
  const cells: string[] = [];
  for (const cost of COSTS) {
    let gain = 0;
    let days = 0;
    for (const [, g] of segments) {
      let sg = 0;
      let sd = 0;
      for (const sb of g) {
        const r = replayTrade(sb, { discountPct: null, windowDays: WINDOW }, s.exit);
        if (!r) continue;
        if (r.triggered) { sg += r.pct - cost; sd += r.holdDays; }
      }
      gain += sg;
      days += sd;
    }
    cells.push(`${(gain / totalN).toFixed(3)}/${(days === 0 ? Number.NaN : gain / days).toFixed(3)}`.padStart(16));
  }
  console.log(`  ${s.label.padEnd(12)}` + cells.join(""));
}
console.log("  （格内为 每信号期望 / 每日期望）");

/**
 * ── 走前验证（walk-forward）──────────────────────────────────────────────
 *
 * 上面那张排序表不能用来报成绩：D1 是从 105 个组合里挑出来的，而挑的时候
 * **所有段（包括被拿来报成绩的那些段）都参与了**。
 * 分段只是把过拟合摊开给人看，并没有把"挑"这个动作从成绩里摘出去。
 *
 * 走前验证才摘得掉：对第 i 段，只准用**它之前的段**选参数，再把选出来的
 * 参数用在它身上。模拟的是真实决策顺序 —— 2024 年做决定时不可能看过 2026 年。
 * 顺便看**每段选出的是不是同一个参数**：如果 6 段选出 6 个不同的，
 * 等于什么都没选出来，那张排序表再漂亮也是噪音。
 */
console.log("\n[horizon] 走前验证：只用之前的段选参数，用在下一段上");
console.log("  验证段     选中参数        该段期望   该段最差   同期现行   增量");
const wfRealized: number[] = [];
const wfBaseline: number[] = [];
const wfChosen: string[] = [];
for (let i = 1; i < segments.length; i++) {
  const train = segments.slice(0, i);
  const test = segments[i];
  const trainN = train.reduce((a, [, g]) => a + g.length, 0);
  let best: { label: string; exit: ExitRule; wMean: number } | null = null;
  for (const c of CANDIDATES) {
    const w = train.reduce(
      (a, [, g]) => a + stat(g, c.exit).meanPct * g.length, 0
    ) / trainN;
    if (!best || w > best.wMean) best = { label: c.label, exit: c.exit, wMean: w };
  }
  const got = stat(test[1], best!.exit);
  const baseGot = stat(test[1], cur);
  wfRealized.push(got.meanPct);
  wfBaseline.push(baseGot.meanPct);
  wfChosen.push(best!.label);
  console.log(
    `  ${test[0].padEnd(10)}${best!.label.padEnd(16)}` +
    `${got.meanPct.toFixed(3).padStart(8)}%  ${"".padStart(8)}` +
    `${baseGot.meanPct.toFixed(3).padStart(9)}%  ${(got.meanPct - baseGot.meanPct >= 0 ? "+" : "")}` +
    `${(got.meanPct - baseGot.meanPct).toFixed(3)}pp`
  );
}
const wfMean = wfRealized.reduce((a, b) => a + b, 0) / wfRealized.length;
const wfBase = wfBaseline.reduce((a, b) => a + b, 0) / wfBaseline.length;
const distinct = new Set(wfChosen);
console.log(
  `  走前平均：选中参数 ${wfMean.toFixed(3)}%  现行口径 ${wfBase.toFixed(3)}%  ` +
  `差 ${(wfMean - wfBase >= 0 ? "+" : "")}${(wfMean - wfBase).toFixed(3)}pp`
);
console.log(`  每段选中的参数：${wfChosen.join(" | ")}`);
console.log(
  `  参数稳定性：${distinct.size} 种 / ${wfChosen.length} 段` +
  (distinct.size <= 2 ? "  ✅ 稳定" : "  ⚠️ 不稳定，等于没选出来")
);

/**
 * 收益是不是被少数极端笔撑起来的？
 *
 * 一个策略可以"期望为正"却完全不可执行：均值 0.22% 而中位数 0、
 * 去掉最好的 1% 就塌掉七成 —— 那是"连亏很久、偶尔一笔暴涨"的形状。
 * 期望一样，实盘体验天差地别，而且一旦暴涨那几笔没吃到（涨停买不进、
 * 没盯盘），整个策略就归零。所以每个候选都要过这一关，光看均值不配落地。
 */
console.log("\n[horizon] 收益分布体检：");
console.log("  参数".padEnd(14) + "  均值    中位    P10     P90   正收益%  去尾1%后  尾部贡献  止盈触发");
const distRows: Array<{ label: string; mean: number; tailShare: number; posRate: number }> = [];
for (const label of [
  "D1/TP4/SL-", "D1/TP5/SL-", "D1/TP6/SL-", "D1/TP8/SL-", "D1/TP10/SL-",
  "D2/TP5/SL-", "D3/TP5/SL-", "现行D5/TP5",
]) {
  const c = CANDIDATES.find(x => x.label === label);
  if (!c) continue;
  const pcts: number[] = [];
  let tpHits = 0;
  let triggered = 0;
  for (const [, g] of segments) {
    for (const sb of g) {
      const r = replayTrade(sb, { discountPct: null, windowDays: WINDOW }, c.exit);
      if (!r) continue;
      pcts.push(r.triggered ? r.pct - COST : 0);
      if (r.triggered) {
        triggered++;
        if (r.exit?.reason === "止盈") tpHits++;
      }
    }
  }
  pcts.sort((a, b) => a - b);
  const q = (p: number) => pcts[Math.floor(p * (pcts.length - 1))];
  const meanAll = pcts.reduce((a, b) => a + b, 0) / pcts.length;
  const top = pcts.slice(-Math.floor(pcts.length * 0.01));
  const rest = pcts.slice(0, pcts.length - top.length);
  const restMean = rest.reduce((a, b) => a + b, 0) / rest.length;
  const tailShare = meanAll === 0 ? Number.NaN : (meanAll - restMean) / meanAll;
  const posRate = pcts.filter(x => x > 0).length / pcts.length;
  distRows.push({ label, mean: meanAll, tailShare, posRate });
  console.log(
    `  ${label.padEnd(12)}${meanAll.toFixed(3).padStart(7)}%${q(0.5).toFixed(2).padStart(7)}%` +
    `${q(0.1).toFixed(2).padStart(7)}%${q(0.9).toFixed(2).padStart(7)}%  ` +
    `${(posRate * 100).toFixed(1).padStart(6)}%  ${restMean.toFixed(3).padStart(7)}%  ` +
    `${(tailShare * 100).toFixed(0).padStart(6)}%  ${(triggered === 0 ? Number.NaN : tpHits / triggered * 100).toFixed(1).padStart(6)}%`
  );
}
console.log("  （尾部贡献 = 去掉最好的 1% 笔后均值掉掉的百分比；越高越靠极端尾部撑着）");

db.close();
