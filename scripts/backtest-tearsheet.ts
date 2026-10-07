/**
 * 把回测报告导出成一份自包含 HTML（tearsheet）。
 *
 * 用法：
 *   npx tsx scripts/backtest-tearsheet.ts --list
 *   npx tsx scripts/backtest-tearsheet.ts --latest
 *   npx tsx scripts/backtest-tearsheet.ts --id 20260930233656188-k5n0
 *   npx tsx scripts/backtest-tearsheet.ts --json some/report.json --out out.html
 *   npx tsx scripts/backtest-tearsheet.ts --latest --bench sh000852   # 换成中证1000
 *   npx tsx scripts/backtest-tearsheet.ts --latest --no-bench         # 不比基准
 *
 * 默认基准是沪深300（sh000300）。可选代码见 lib/data/indices.ts —— 只认采了日线的那几条，
 * 瞎编一个代码不会"查不到就当没基准"，而是直接报错。
 *
 * --json 是留给"报告不在本机库里"的情况：别人跑的那份、或者从别处拷来的 JSON。
 * 这也是 tearsheet 要自包含的另一个理由 —— 它得能离开这台机器还成立。
 *
 * CLI 不读 .env.local（只有 next 会读），这里补上，免得在默认目录上操作一个空库。
 */
import { loadCliEnv } from "@/lib/config";
loadCliEnv();

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { openDb } from "@/lib/db";
import { runMigrations } from "@/lib/db/migrate";
import { checkBacktestShape, renderTearsheet } from "@/lib/backtest/tearsheet";
import { DEFAULT_BENCHMARK, loadBenchmarkWithStats } from "@/lib/backtest/benchmark";
import type { BacktestReport } from "@/lib/contracts/backtest";

function arg(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return null;
  const v = process.argv[i + 1];
  return v === undefined || v.startsWith("--") ? null : v;
}
const has = (name: string) => process.argv.includes(`--${name}`);

function write(html: string, out: string): void {
  const abs = resolve(out);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, html, "utf8");
  console.log(`已写出 ${abs}（${(Buffer.byteLength(html, "utf8") / 1024).toFixed(1)} KB）`);
}

const db = openDb();
runMigrations(db);

/**
 * 基准。默认沪深300，--no-bench 关掉。
 *
 * 显式给了 --bench 却取不到要**吵一声**（stderr），但仍然出报告并在里面写明无基准：
 * 静默降级会让"我要对比沪深300"变成"报告里根本没有这一块"，而后者看起来是正常的。
 */
const benchArg = arg("bench");
const benchCode = has("no-bench") ? null : benchArg ?? DEFAULT_BENCHMARK;

function withBenchmark(report: BacktestReport) {
  if (benchCode === null) return { note: "" };
  const r = loadBenchmarkWithStats(db, benchCode, report.equity);
  if (r.ok) return { benchmark: { series: r.series, stats: r.stats } };
  if (benchArg !== null) {
    console.error(`警告：取不到基准 ${benchCode} —— ${r.reason}`);
  }
  return { benchmarkReason: r.reason };
}

if (has("list")) {
  const rows = db.prepare(
    `SELECT id, ts, kind, strategy_id, strategy_ver, from_date, to_date, calmar, trades, evaluated
       FROM backtest_report ORDER BY ts DESC LIMIT 30`
  ).all() as Array<Record<string, unknown>>;
  if (rows.length === 0) console.log("库里还没有回测存档。先在实验室页面跑一次回测。");
  for (const r of rows) {
    console.log(
      `${r.id}  ${r.kind}  ${r.strategy_id} v${r.strategy_ver}  ${r.from_date}~${r.to_date}` +
      `  calmar=${r.calmar ?? "-"}  trades=${r.trades ?? "-"}  ${r.ts}`
    );
  }
  db.close();
  process.exit(0);
}

const jsonPath = arg("json");
const id = arg("id");

if (jsonPath !== null) {
  const parsed: unknown = JSON.parse(readFileSync(resolve(jsonPath), "utf8"));
  const c = checkBacktestShape(parsed);
  if (!c.ok) throw new Error(`这份 JSON 不是 BacktestReport，缺：${c.missing.join("、")}`);
  write(
    renderTearsheet(c.report, withBenchmark(c.report)),
    arg("out") ?? `reports/${c.report.strategyId}-${c.report.range.from}.html`,
  );
  db.close();
  process.exit(0);
}

// 没给 id 也没给 --latest 时，默认取最新的一份 backtest：这是最常用的那一次
const row = id === null
  ? db.prepare(
      `SELECT id, kind, report_json FROM backtest_report
        WHERE kind = 'backtest' ORDER BY ts DESC LIMIT 1`
    ).get() as { id: string; kind: string; report_json: string } | undefined
  : db.prepare("SELECT id, kind, report_json FROM backtest_report WHERE id = ?").get(id) as
      { id: string; kind: string; report_json: string } | undefined;

if (row === undefined) {
  db.close();
  throw new Error(id === null ? "库里还没有回测存档" : `找不到存档 ${id}（用 --list 看现有 id）`);
}
if (row.kind === "sweep") {
  db.close();
  throw new Error(`${row.id} 是参数扫描报告，结构不同，渲染不出来。请给一份回测（kind=backtest）的 id。`);
}

let parsed: unknown;
try {
  parsed = JSON.parse(row.report_json);
} catch {
  db.close();
  throw new Error(`存档 ${row.id} 的 JSON 坏了，无法解析`);
}

const c = checkBacktestShape(parsed);
if (!c.ok) {
  db.close();
  throw new Error(`存档 ${row.id} 不是有效的 BacktestReport，缺：${c.missing.join("、")}`);
}

const out = arg("out") ?? `reports/${row.id}.html`;
write(
  renderTearsheet(c.report, { note: `　由存档 ${row.id} 导出。`, ...withBenchmark(c.report) }),
  out,
);
db.close();
