/**
 * 影子盘冷启动回放。
 *
 * 用法：pnpm shadow:replay [起始日] [截止日]
 *   默认从 2023-11-22（五段状态机能判出阶段的第一天）回放到最近一个有日线的交易日。
 *
 * 可中断：Ctrl-C 之后再跑，已完成的日子自动跳过。
 * 回放样本只用于排座次，不计入毕业（见 lib/shadow/replay.ts）。
 */
import { openDb } from "@/lib/db";
import { runMigrations } from "@/lib/db/migrate";
import { loadStrategyFile } from "@/lib/strategy/loader";
import { activeStrategyPath } from "@/lib/strategy/registry";
import { replayShadow } from "@/lib/shadow/replay";
import { variantReports } from "@/lib/shadow/report";

const db = openDb();
runMigrations(db);
const path = activeStrategyPath();
if (path === null) throw new Error("没有生效的策略文件");
const { config } = loadStrategyFile(path);
const latest = (db.prepare("SELECT MAX(date) AS d FROM kline_daily").get() as { d: string }).d;
const from = process.argv[2] ?? "2023-11-22";
const to = process.argv[3] ?? latest;

const t0 = Date.now();
let n = 0;
const r = replayShadow(db, {
  from, to, config, settleAsOf: latest,
  onDay: (d, rec, fail) => {
    if (++n % 20 === 0 || fail > 0) console.log(`[${Math.round((Date.now() - t0) / 1000)}s] ${d} 新记 ${rec}${fail > 0 ? ` 失败 ${fail}` : ""}`);
  },
});
console.log(JSON.stringify({ ...r, failed: r.failed.slice(0, 10), 失败总数: r.failed.length, 秒: Math.round((Date.now() - t0) / 1000) }, null, 2));

const pct = (x: number | null) => (x === null ? "—" : `${(x * 100).toFixed(1)}%`);
const num = (x: number | null, d = 2) => (x === null ? "—" : x.toFixed(d));
console.log("\n变体 | 已结算 | 触发率 | 胜率 | 期望(%/笔) | 盈亏比 | 最大回撤(pp) | 对 baseline 差 | t");
for (const v of variantReports(db, "replay")) {
  const s = v.summary;
  console.log([v.name, s.settled, pct(s.triggerRate), pct(s.winRate), num(s.meanNet), num(s.payoff), num(s.maxDrawdown, 1),
    v.vsBaseline ? num(v.vsBaseline.diff) : "—", v.vsBaseline ? num(v.vsBaseline.t) : "—"].join(" | "));
}
db.close();
