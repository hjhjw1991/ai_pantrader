/**
 * 成本压力测试的入口：把滑点与费用按倍数往上加，看策略在第几倍上不再赚钱。
 *
 * 用法：
 *   npx tsx scripts/backtest-cost-stress.ts
 *   npx tsx scripts/backtest-cost-stress.ts --from 2023-01-01 --to 2026-09-30
 *   npx tsx scripts/backtest-cost-stress.ts --levels 1,2,3
 *   npx tsx scripts/backtest-cost-stress.ts --plan --json out/cost.json
 *
 * 为什么要有这个命令：
 * 库里那份有 126 笔的真回测，全年成交额是本金的 30 倍、成本占本金 6.19%、净收益 7.38%，
 * 毛收益 13.57% —— **成本吃掉了将近一半的毛收益**。在这个比例下，
 * "滑点翻倍还赚不赚钱"决定这个策略成不成立，而在此之前没有任何入口能问这句话：
 * 滑点与费率是写死的 DEFAULT_CONSTRAINTS，回测面板也不给改。
 *
 * 每一档都是一次完整回测，没有捷径。解析外推（跑一次然后按倍数从收益里减成本）
 * 是错的：滑点改变成交价 → 净值 → 仓位 → 手数取整 → 这笔能不能成交，路径整个变了。
 * 所以默认 5 档 = 5 次回测，先 --plan 看清楚再跑。
 *
 * 另一件事：默认区间取交易日历全长，而 MIN_SAMPLE_DAYS 是 252 个交易日。
 * 库里唯一那份真回测只有 231 天，因此 Calmar 被判退化记 0 —— 那不是策略不行，
 * 是**从来没跑出过一次够长的回测**。这个脚本顺手把这件事也办了。
 *
 * CLI 不读 .env.local（只有 next 会读），这里补上，免得在默认目录上操作一个空库。
 */
import { loadCliEnv } from "@/lib/config";
loadCliEnv();

import { writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { openDb } from "@/lib/db";
import { runMigrations } from "@/lib/db/migrate";
import { createSqliteView } from "@/lib/pit/sqlite-view";
import { runBacktest as replay } from "@/lib/backtest/replay";
import {
  scaleConstraints, levelOf, toStressPoint, evaluateCostStress,
  type CostLevel, type CostStressPoint, type StressOutcome,
} from "@/lib/backtest/cost-stress";
import { DEFAULT_CONSTRAINTS, type BacktestReport, type Constraints } from "@/lib/contracts";
import { MIN_SAMPLE_DAYS } from "@/lib/backtest/metrics";
import { createV2Engine, defaultSlotRegistry } from "@/lib/strategy/v2";
import { defaultRegistry } from "@/lib/factors";
import { readStrategyConfig } from "@/lib/ui/adapters/strategy";
import { saveBacktestReport } from "@/lib/ui/mutations";
import { shanghaiTs } from "@/lib/ui/time";

function arg(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return null;
  const v = process.argv[i + 1];
  return v === undefined || v.startsWith("--") ? null : v;
}
const has = (name: string) => process.argv.includes(`--${name}`);

const db = openDb();
runMigrations(db);

const cfg = readStrategyConfig();
if (!cfg.available) {
  console.error(`策略配置不可用：${cfg.reason}`);
  process.exit(2);
}
const baseConfig = cfg.config;

const engine = createV2Engine({ registry: defaultRegistry, slots: defaultSlotRegistry });
const cash = Number(arg("cash") ?? "100000");
if (!Number.isFinite(cash) || cash <= 0) {
  console.error("--cash 必须是正数（初始资金决定手数取整能不能成交，不替人假设）");
  process.exit(2);
}

/** 成本档位。默认含 ×0（策略上限）与 ×1（现行假设） */
const levels = (arg("levels") ?? "0,1,1.5,2,3")
  .split(",")
  .map((s) => Number(s.trim()))
  .filter((n) => Number.isFinite(n) && n >= 0);
if (levels.length === 0) {
  console.error("--levels 没有解析出合法档位（写法：--levels 0,1,2,3）");
  process.exit(2);
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
if (days.length === 0) {
  console.error(`${range.from} → ${range.to} 没有交易日`);
  process.exit(2);
}

const base: Constraints = DEFAULT_CONSTRAINTS;

/**
 * 跑一个成本档位。
 * 直接调 replay 而不走 engines.runBacktest：后者会包装成 BacktestReport 并存档，
 * 这里要的只是"这个成本下的指标与净值"，而且多数档位是探针，不该进存档。
 *
 * 现行那一档的报告留一份：--save 时直接拿它存档，不再多跑一次回测
 * （一次四年跨度的回测是好几分钟，能为省一次重跑多存一个变量是划算的）。
 */
// 用对象装着而不是裸 let：TS 会把"只在闭包里赋值的 let"窄化成 never，
// 外面读它时类型就成了 never（闭包内赋值不参与外部的控制流分析）
const store: { baseline: BacktestReport | null } = { baseline: null };
function run(level: CostLevel): StressOutcome {
  const t = Date.now();
  let out: ReturnType<typeof replay>;
  try {
    out = replay({
      from: range.from, to: range.to,
      viewFactory: (asOf: string) => createSqliteView(db, asOf),
      strategy: engine,
      config: baseConfig,
      initialCash: cash,
      generatedAt,
      constraints: scaleConstraints(base, level.multiplier),
    });
  } catch (e) {
    // 这个错踩过一次，值得专门认出来：跑测在密集读库，采集进程在并发写，
    // 撞上时 SQLite 报 disk I/O error。它不是策略的问题，也不是库坏了，
    // 但报错长这样的时候没人看得出来 —— 所以在这里直接把处置办法说出来。
    const msg = String((e as Error)?.message ?? e);
    if (/disk i\/o error|SQLITE_IOERR/i.test(msg)) {
      console.error(
        `\n读库失败（disk I/O error）：几乎一定是采集进程正在并发写同一个库。\n` +
        `处置：先用 sqlite 的 backup 做一份一致性快照，再用\n` +
        `  PANTRADER_DATA_DIR=<快照目录> npx tsx scripts/backtest-cost-stress.ts ...\n` +
        `跑快照（快照目录里要有 data/pantrader.db）。不想做快照就先停 daemon，跑完再启动。\n` +
        `库本身多半是好的 —— 别急着去修库。`
      );
      process.exit(3);
    }
    throw e;
  }
  if (level.multiplier === 1) store.baseline = out.report;
  const eq = out.report.equity;
  const tr = eq.length > 1 ? eq[eq.length - 1].equity / eq[0].equity - 1 : 0;
  // 逐档打印：一档要好几分钟，跑完一档说一声，挂了也留得下已经跑出来的那几档
  console.log(
    `  ×${level.multiplier} 跑完：总收益 ${(tr * 100).toFixed(2)}%、` +
    `${out.report.metrics.trades} 笔、Calmar ${out.report.metrics.calmar.toFixed(3)}（${((Date.now() - t) / 1000).toFixed(1)} 秒）`
  );
  return { metrics: out.report.metrics, equity: out.report.equity };
}

console.log(`区间 ${range.from} → ${range.to}，${days.length} 个交易日，本金 ${cash.toLocaleString("zh-CN")}`);
if (days.length < MIN_SAMPLE_DAYS) {
  console.log(
    `注意：${days.length} < ${MIN_SAMPLE_DAYS} 个交易日，Calmar 会被 metrics 判退化记 0。\n` +
    `想拿到不退化的 Calmar，区间至少要 ${MIN_SAMPLE_DAYS} 个交易日（多加 --from 往前推）。\n` +
    `（本命令的盈亏判定看总收益，不受退化影响，但 Calmar 那一列会是 0。）`
  );
}
console.log(
  `成本档位：×${levels.join(" ×")}（×0 = 零摩擦看上限，×1 = 现行假设 ${(base.slippage * 100).toFixed(2)}% 滑点 / ${(base.feeRate * 100).toFixed(3)}% 费率）`
);
/**
 * 断点续跑。
 *
 * 为什么必须有：一档回测十几分钟，连跑几档会在 3.78GB 的库上撞 SQLite 的
 * disk I/O error（实测两次都在第 2~3 档崩）。崩一次就全部重来是受不了的，
 * 而每档的结果只有几个数字 —— 落盘几乎不要钱。
 *
 * 于是每次启动只跑缺失的档位，跑完一档立刻写盘。附带好处：
 * 每档一个进程 = 每次重启都释放掉上一档攒下的内存，崩溃反而更少。
 */
const statePath = arg("state");
let done: CostStressPoint[] = [];
if (statePath !== null) {
  try {
    const s = JSON.parse(readFileSync(resolve(process.cwd(), statePath), "utf8")) as {
      range?: { from: string; to: string }; cash?: number; points?: CostStressPoint[];
    };
    if (s.range?.from === range.from && s.range?.to === range.to && s.cash === cash) {
      done = Array.isArray(s.points) ? s.points : [];
      console.log(`续跑：${statePath} 里已有 ×${done.map((p) => p.level.multiplier).join(" ×")}`);
    } else {
      console.log(`state 文件的区间/本金与本次不符（${s.range?.from}~${s.range?.to} / ${s.cash}），忽略，从头跑`);
    }
  } catch {
    console.log(`读不到 ${statePath}（还不存在），从头跑`);
  }
}
const doneSet = new Set(done.map((p) => p.level.multiplier));
const todo = levels.filter((m) => !doneSet.has(m));

console.log(
  `要跑 ${levels.length} 个档位，其中已完成 ${done.length} 个、本次跑 ${todo.length} 个` +
  `${todo.length > 0 ? `（×${todo.join(" ×")}）` : ""}\n`
);

if (has("plan")) {
  console.log("--plan：只看计划，不跑回测。去掉 --plan 才真的跑。");
  process.exit(0);
}

const t0 = Date.now();
const all: CostStressPoint[] = [...done];
for (const m of todo) {
  const lv = levelOf(base, m);
  const out = run(lv);
  all.push(toStressPoint(lv, out));
  if (statePath !== null) {
    writeFileSync(resolve(process.cwd(), statePath), JSON.stringify({
      range, cash, baseConstraints: base, points: all,
    }, null, 2), "utf8");
  }
}
const r = evaluateCostStress(all);
const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

const pad = (s: string | number, n: number) => String(s).padStart(n);
const pct = (x: number) => `${(x * 100).toFixed(2)}%`;

console.log(
  `${pad("成本档", 8)}${pad("总收益", 10)}${pad("年化", 10)}${pad("Calmar", 9)}${pad("盈亏比", 9)}${pad("笔数", 7)}  备注`
);
for (const p of r.points) {
  const m = p.level.multiplier;
  const tag = m === 0 ? "零摩擦（上限）" : m === 1 ? "现行假设" : p.degenerated ? "指标退化" : "";
  console.log(
    `${pad("×" + m, 8)}${pad(pct(p.totalReturn), 10)}${pad(pct(p.annualReturn), 10)}` +
    `${pad(p.calmar.toFixed(3), 9)}${pad(p.profitFactor.toFixed(3), 9)}${pad(p.trades, 7)}  ${tag}`
  );
}

console.log("");
const verdictText: Record<string, string> = {
  unprofitable: "不赚钱",
  veryFragile: "极脆弱（成本涨一半就死）",
  fragile: "脆弱",
  robust: "扛得住",
  undecidable: "判不出（档位不够）",
};
console.log(`判定：${verdictText[r.verdict] ?? r.verdict}`);
if (r.breakevenMultiplier !== null) {
  console.log(
    `归零点：成本涨到 ×${r.breakevenMultiplier.toFixed(2)} 时净收益归零` +
    `（现行滑点 ${(base.slippage * 100).toFixed(2)}% → ${(base.slippage * r.breakevenMultiplier * 100).toFixed(2)}%）`
  );
} else if (r.neverBreaks) {
  console.log(`归零点：已测最高 ×${r.points[r.points.length - 1].level.multiplier} 仍未归零 —— 边界在更高处，本次没测到，不外推`);
}
if (r.costShare !== null) {
  console.log(`成本占比：吃掉了零摩擦收益的 ${(r.costShare * 100).toFixed(1)}%`);
}
console.log(`\n${r.note}`);
console.log(`\n耗时 ${elapsed} 秒（${levels.length} 次回测，每次约 ${(Number(elapsed) / levels.length).toFixed(1)} 秒）`);

if (has("json")) {
  const outPath = resolve(process.cwd(), arg("json") ?? "");
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify({
    range, days: days.length, initialCash: cash,
    baseConstraints: base, ...r,
  }, null, 2), "utf8");
  console.log(`已写出 ${outPath}`);
}

/**
 * --save 只存现行成本那一档（×1）。
 * 加压档是探针，不是"这份策略的成绩"，存进去会让人以后分不清哪份是真结论。
 */
if (has("save") && r.baseline !== null && store.baseline !== null) {
  const baselineReport = store.baseline;
  const id = saveBacktestReport(db, {
    kind: "backtest",
    strategyId: baselineReport.strategyId,
    strategyVersion: baselineReport.strategyVersion,
    from: range.from, to: range.to,
    initialCash: cash,
    metrics: baselineReport.metrics,
    report: baselineReport,
  });
  console.log(
    `\n已存档现行成本那一档：${id}（${baselineReport.metrics.trades} 笔，` +
    `Calmar ${baselineReport.metrics.calmar.toFixed(3)}，区间 ${days.length} 个交易日）`
  );
} else if (has("save")) {
  console.log("\n--save 没能存档：本次没有跑现行成本那一档（×1）");
}

// 退出码：不赚钱就是失败，好让这条命令能当门槛用。
// 脆弱只告警不判失败 —— 它是风险提示，不是"这条命令跑挂了"
if (r.verdict === "unprofitable") process.exit(1);
if (has("strict") && (r.verdict === "veryFragile" || r.verdict === "fragile")) process.exit(1);
