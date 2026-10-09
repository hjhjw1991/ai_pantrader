/**
 * walk-forward 滚动验证（spec §10.4）的入口。
 *
 * 用法：
 *   npx tsx scripts/backtest-walkforward.ts
 *   npx tsx scripts/backtest-walkforward.ts --from 2023-01-01 --to 2026-09-30
 *   npx tsx scripts/backtest-walkforward.ts --grid exit.stop=-0.08,-0.10,-0.12 --grid entry.topN=3,5
 *   npx tsx scripts/backtest-walkforward.ts --aggregated --json out/wf.json
 *   npx tsx scripts/backtest-walkforward.ts --window-days 315 --train-days 252   # 步长默认 = 测试段
 *
 * 退出码：不给 --aggregated 时跟单窗口裁决；给了就跟聚合裁决（单窗口一个季度必然退化，不能当门槛）。
 *
 * 为什么需要这个脚本：walk-forward 的全套实现（7:3 切分、样本外裁决、样本内外落差、
 * 参数稳定性、聚合样本外）**写完了却没有一个入口**，只活在测试里 ——
 * 等于从没对真实数据跑过。一个没跑过的防过拟合措施，和没有是一样的。
 *
 * 三条纪律在这个脚本里是硬约束，不是口号：
 *   1. 每个窗口的寻优只拿到训练区间，函数签名决定了它拿不到测试区间；
 *   2. 每个窗口的样本外只评估一次，结果立刻冻结（runWalkForward 内部）；
 *   3. 没有 override 参数可以"再看一眼样本外" —— 不过就是不过。
 *
 * 算力提醒：窗口数 × 网格点数 次完整回测。默认切法是"训练 252 天 / 测试 63 天"，
 * 也就是每 63 个交易日重挑一次参数。--aggregated 会把每个窗口再跑一遍
 * （要各段的净值曲线才能拼起来），算力翻倍。
 *
 * CLI 不读 .env.local（只有 next 会读），这里补上，免得在默认目录上操作一个空库。
 */
import { loadCliEnv } from "@/lib/config";
loadCliEnv();

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { openDb } from "@/lib/db";
import { runMigrations } from "@/lib/db/migrate";
import { createSqliteView } from "@/lib/pit/sqlite-view";
import { runBacktest as replay } from "@/lib/backtest/replay";
import { optimize, gridPoints, type ParamGrid } from "@/lib/backtest/optimizer";
import {
  planWalkForward, runWalkForward, runWalkForwardAggregated,
  walkForwardVerdict, summarizeWalkForward, analyzeParamStability, suggestAggregatedPlan,
  aggregatedVerdict, walkForwardExitCode, type AggregatedVerdict,
} from "@/lib/backtest/walkforward";
import { MIN_SAMPLE_DAYS } from "@/lib/backtest/metrics";
import { createV2Engine, defaultSlotRegistry } from "@/lib/strategy/v2";
import { defaultRegistry } from "@/lib/factors";
import { readStrategyConfig, overrideConfigParams } from "@/lib/ui/adapters/strategy";
import { shanghaiTs } from "@/lib/ui/time";
import type { BacktestMetrics, EquityPoint } from "@/lib/contracts";
import type { ClosedTrade } from "@/lib/backtest/types";

function arg(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return null;
  const v = process.argv[i + 1];
  return v === undefined || v.startsWith("--") ? null : v;
}
const has = (name: string) => process.argv.includes(`--${name}`);
const allArgs = (name: string): string[] => {
  const out: string[] = [];
  for (let i = 0; i < process.argv.length; i++) {
    if (process.argv[i] === `--${name}`) {
      const v = process.argv[i + 1];
      if (v !== undefined && !v.startsWith("--")) out.push(v);
    }
  }
  return out;
};

const db = openDb();
runMigrations(db);

const cfg = readStrategyConfig();
if (!cfg.available) {
  console.error(`策略配置不可用：${cfg.reason}`);
  process.exit(2);
}
const baseConfig = cfg.config;

/** 引擎实例。与 UI 那条路径同一个构造，不在脚本里另造一个打法 */
const engine = createV2Engine({ registry: defaultRegistry, slots: defaultSlotRegistry });
const cash = Number(arg("cash") ?? "100000");
if (!Number.isFinite(cash) || cash <= 0) {
  console.error("--cash 必须是正数（初始资金决定手数取整能不能成交，不替人假设）");
  process.exit(2);
}

/** 网格：--grid path=v1,v2 可重复。不给 = 只跑当前配置，不做寻优 */
const grid: Record<string, unknown[]> = {};
for (const g of allArgs("grid")) {
  const at = g.indexOf("=");
  if (at <= 0) { console.error(`--grid 写法是 path=v1,v2，收到了 "${g}"`); process.exit(2); }
  const path = g.slice(0, at);
  const values = g.slice(at + 1).split(",").map((s) => {
    const t = s.trim();
    if (t === "true") return true;
    if (t === "false") return false;
    const n = Number(t);
    return t !== "" && Number.isFinite(n) ? n : t;
  });
  if (values.length === 0) { console.error(`--grid ${path} 没有取值`); process.exit(2); }
  grid[path] = values;
}
const gridSize = Object.keys(grid).length === 0 ? 1 : gridPoints(grid as ParamGrid).length;

interface Once {
  metrics: BacktestMetrics;
  equity: EquityPoint[];
  closed: ClosedTrade[];
}

/**
 * 跑一段区间。
 *
 * 不走 engines.runBacktest 是因为聚合模式要**逐笔明细**（closed）：
 * 拼完净值曲线后要在拼接曲线上重算指标，而 BacktestReport 是冻结契约、不带明细。
 * 明细只在 replay 的 detail 里 —— 于是这里直接调 replay，不绕那一层。
 */
function runOnce(from: string, to: string, params: Record<string, unknown>, at: string): Once {
  const r = overrideConfigParams(baseConfig, params);
  if (!r.ok) throw new Error(`参数 ${JSON.stringify(params)} 非法：${r.reason}`);
  const out = replay({
    from, to,
    viewFactory: (asOf: string) => createSqliteView(db, asOf),
    strategy: engine,
    config: r.config,
    initialCash: cash,
    generatedAt: at,
  });
  return { metrics: out.report.metrics, equity: out.report.equity, closed: out.detail.closed };
}

const generatedAt = shanghaiTs();
const view = createSqliteView(db, "9999-12-31");
const range = (() => {
  const row = db.prepare(
    `SELECT MIN(date) a, MAX(date) b FROM trading_calendar WHERE is_open = 1`
  ).get() as { a: string | null; b: string | null };
  return { from: arg("from") ?? row.a ?? "", to: arg("to") ?? row.b ?? "" };
})();
if (range.from === "" || range.to === "") {
  console.error("取不到交易日历区间，先用 --from/--to 指定，或先跑采集");
  process.exit(2);
}
const days = view.tradingDays(range.from, range.to);

const totalDays = days.length;
const suggested = suggestAggregatedPlan(totalDays);
const windowDays = Number(arg("window-days") ?? suggested?.windowDays ?? MIN_SAMPLE_DAYS * 2);
/**
 * 训练段天数。没手动改窗口就沿用建议切法的"训练 252 / 测试 63"，
 * 否则 planWalkForward 会把 315 天按 7:3 重切成 221/94 —— 测试段比步长长 31 天，
 * 聚合时重叠日被复利两次（实测 1065 个交易日拼出 1116 天）。
 * 手动给了 --window-days 又没给 --train-days，就退回 7:3。
 */
const trainArg = arg("train-days");
const trainDays: number | undefined = trainArg !== null
  ? Number(trainArg)
  : arg("window-days") === null && suggested !== null ? suggested.trainDays : undefined;
const trainLen = trainDays ?? Math.round(windowDays * 0.7);
const testLen = windowDays - trainLen;
// 步长默认 = 测试段长度，样本外首尾相接、互不重叠；只有显式 --step-days 才可能偏离
const stepDays = Number(arg("step-days") ?? testLen);
const splits = planWalkForward(days, { windowDays, stepDays, trainDays });

console.log(`区间 ${range.from} → ${range.to}，${totalDays} 个交易日`);
if (Object.keys(grid).length === 0) {
  console.log(
    "没有 --grid：各窗口都跑当前配置，不寻优 —— 这只能验证「这套配置在样本外还行不行」，\n" +
    "验证不了「参数是不是挑出来的」（参数稳定性那栏会照实写「谈不上」）。\n" +
    "要完整 walk-forward，用 --grid 路径=v1,v2 指定寻优网格。"
  );
}
console.log(
  `切法：窗口 ${windowDays} 天（训练 ${trainLen} / 测试 ${testLen}）、` +
  `步长 ${stepDays} 天 → ${splits.length} 个窗口；每窗口寻优 ${gridSize} 个组合`
);
if (stepDays < testLen) {
  console.warn(
    `注意：步长 ${stepDays} < 测试段 ${testLen}，相邻窗口的样本外重叠 ${testLen - stepDays} 天。` +
    `单窗口裁决会重复计这些天；--aggregated 拼接时只认先到的那段（重叠日不复利两次）。`
  );
}
if (splits.length === 0) {
  console.error(
    `\n凑不出一个完整窗口：${totalDays} 个交易日 < 窗口 ${windowDays} 天。` +
    `半个窗口的样本外结论没有意义，所以宁可不跑 —— 加长区间或缩小 --window-days。`
  );
  process.exit(1);
}
if (has("plan")) {
  // 先看清楚要跑多少再决定跑不跑：窗口数 × 网格点 = 完整回测次数，
  // 而一次四年跨度的回测是 6 分钟 —— 扫一眼计划再动手，比跑一半发现要三小时强
  console.log(
    `\n计划：${splits.length} 个窗口 × ${gridSize} 个组合 = ${splits.length * gridSize * 2} 次回测` +
    `（每个窗口一次训练段寻优 + 一次样本外评估；--aggregated 再翻倍）`
  );
  splits.forEach((s, i) => {
    console.log(
      `  ${i + 1}. 训练 ${s.train.from}~${s.train.to}（${s.trainDays.length} 天）` +
      ` → 测试 ${s.test.from}~${s.test.to}（${s.testDays.length} 天）`
    );
  });
  process.exit(0);
}

if (totalDays < MIN_SAMPLE_DAYS * 2) {
  console.error(
    `\n数据不够：${totalDays} 个交易日 < ${MIN_SAMPLE_DAYS * 2}。` +
    `样本外要撑满 ${MIN_SAMPLE_DAYS} 天（一年）才不退化，7:3 切分意味着总量至少 ${Math.round(MIN_SAMPLE_DAYS / 0.3)} 天。`
  );
  process.exit(1);
}

const inSample: BacktestMetrics[] = [];

/**
 * 窗口内寻优。只拿到训练区间 —— 签名决定了它看不见测试段，
 * 想在实现里偷看也没有入口（同 lib/backtest/walkforward.ts 顶上的三条纪律）。
 *
 * record=false 是给聚合模式用的：那次会把每个窗口再跑一遍，
 * 样本内指标不该被重复记一次（记了就把 decay 的分母算大了）。
 */
const optimizeFn = (record: boolean) => (train: { from: string; to: string }) => {
  // 没有网格就没有"寻优"这回事：跑一次当前配置，参数就是空集
  if (Object.keys(grid).length === 0) {
    const m = runOnce(train.from, train.to, {}, generatedAt).metrics;
    if (record) inSample.push(m);
    return { params: {}, metrics: m };
  }
  const r = optimize({
    grid: grid as ParamGrid,
    evaluate: (p) => runOnce(train.from, train.to, p, generatedAt).metrics,
  });
  if (record) inSample.push(r.best.metrics);
  return { params: r.best.params, metrics: r.best.metrics };
};

const wfOptions = {
  windowDays, stepDays, trainDays,
  optimize: optimizeFn(true),
  evaluate: (params: Record<string, unknown>, test: { from: string; to: string }) =>
    runOnce(test.from, test.to, params, generatedAt).metrics,
};

const aggOptions = {
  windowDays, stepDays, trainDays,
  optimize: optimizeFn(false),
  // 聚合要净值曲线与逐笔：只有拼成一条连续曲线，指标才够 252 天不退化
  evaluate: (params: Record<string, unknown>, test: { from: string; to: string }) =>
    runOnce(test.from, test.to, params, generatedAt),
};

const windows = runWalkForward(days, wfOptions);

console.log("");
windows.forEach((w, i) => {
  console.log(
    `窗口 ${i + 1}/${windows.length}  训练 ${w.train.from}~${w.train.to}  测试 ${w.test.from}~${w.test.to}` +
    `  参数 ${JSON.stringify(w.bestParams)}  样本外 Calmar ${w.testMetrics.calmar.toFixed(3)}`
  );
});

const verdict = walkForwardVerdict(windows);
const decay = summarizeWalkForward(windows, inSample);
const stability = analyzeParamStability(windows);

console.log("\n── 样本外裁决 ──");
console.log(`判定：${verdict.pass ? "通过" : "不通过"}${verdict.undecidable ? "（测不出结论）" : ""}`);
console.log(`  窗口 ${verdict.windows} 个，样本外 Calmar 中位数 ${verdict.medianOosCalmar.toFixed(3)}，达标率 ${(verdict.passRatio * 100).toFixed(0)}%`);
for (const r of verdict.reasons) console.log(`  · ${r}`);

console.log("\n── 样本内外落差 ──");
console.log(
  `  样本内 ${decay.meanInSampleCalmar.toFixed(3)} → 样本外 ${decay.meanOutOfSampleCalmar.toFixed(3)}` +
  `  （decay ${decay.decayRatio.toFixed(2)}）${decay.overfitSuspected ? "  ← 疑似过拟合" : ""}`
);

console.log("\n── 参数稳定性 ──");
console.log(`  ${stability.note}`);
for (const a of stability.axes) {
  console.log(`  · ${a.axis}：${a.values.map((v) => JSON.stringify(v)).join(" → ")}`);
}

let aggVerdict: AggregatedVerdict | null = null;
if (has("aggregated")) {
  console.log("\n── 聚合样本外（每段样本外净值拼成一条曲线）──");
  const agg = runWalkForwardAggregated(days, aggOptions);
  aggVerdict = aggregatedVerdict(agg);
  console.log(
    `  ${agg.segments} 段拼接 → ${agg.oosDays} 个样本外交易日` +
    `（阈值 ${MIN_SAMPLE_DAYS}），Calmar ${agg.metrics.calmar.toFixed(3)}`
  );
  if (agg.degeneracy.length > 0) console.log(`  退化：${agg.degeneracy.join("；")}`);
  if (agg.segmentCalmars.length > 0) {
    console.log(`  各段 Calmar：${agg.segmentCalmars.map((c) => c.toFixed(2)).join("、")}`);
  }
  console.log(`判定：${aggVerdict.pass ? "通过" : "不通过"}${aggVerdict.undecidable ? "（测不出结论）" : ""}（退出码以此为准）`);
  for (const r of aggVerdict.reasons) console.log(`  · ${r}`);
} else if (suggested !== null && suggested.oosDays >= MIN_SAMPLE_DAYS) {
  console.log(
    `\n提示：单窗口样本外只有 ${testLen} 天，` +
    `不足 ${MIN_SAMPLE_DAYS} 天会被判退化（Calmar 记 0）。` +
    `加 --aggregated 把各段拼成 ${suggested.oosDays} 天再判，代价是每个窗口多跑一遍。`
  );
}

const out = arg("json");
if (out !== null) {
  const abs = resolve(out);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, JSON.stringify({
    range, windowDays, stepDays, trainDays: trainLen, testDays: testLen, grid,
    generatedAt,
    windows, verdict, decay, stability, aggregatedVerdict: aggVerdict,
  }, null, 2), "utf8");
  console.log(`\n已写出 ${abs}`);
}

// 不通过就是失败退出：让"跑过 walk-forward"这件事能在脚本/CI 里当门槛用，
// 而不是"看一眼输出、自己决定信不信"。给了 --aggregated 就以聚合裁决为准（见 walkForwardExitCode）
process.exit(walkForwardExitCode(verdict, aggVerdict));
