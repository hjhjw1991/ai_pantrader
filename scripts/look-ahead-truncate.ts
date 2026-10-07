/**
 * 未来函数实证检测（可弃副本版）。
 *
 * 为什么必须物理删：createSqliteView 声称每条 SQL 都夹了 asOf，但 SQL 条件拦不住
 * 「asOf 之后才被写入」的行 —— 只要某条路径读了它们，回测就会变漂亮且不报错。
 *
 * 做法：拷一份可弃副本 → 先对全部检测日取快照 → 再按日期**从大到小**逐次截断
 * （后一次删除是前一次的超集，所以一份副本能测完所有日子）→ 逐个比对。
 */
import { loadCliEnv } from "@/lib/config";
loadCliEnv();
import { openDb } from "@/lib/db";
import { runMigrations } from "@/lib/db/migrate";
import { createSqliteView } from "@/lib/pit/sqlite-view";
import { identifyMainlines } from "@/lib/factors/sectors";

const SCRATCH = process.env.SCRATCH ?? "E:/project/PanTraderData/data/lookahead_probe.db";
const DAYS = (process.argv.slice(2).length ? process.argv.slice(2) : ["2025-06-16","2026-03-16","2026-08-17"]).sort();
const TAB_DATE: [string, string][] = [
  ["dt_pool","date"],["kline_daily","date"],["kline_period","date"],["lhb","date"],["lhb_seat","date"],
  ["lift_schedule","free_date"],["margin_market","date"],["margin_stock","date"],["mutual_deal","date"],
  ["mutual_top10","date"],["reduction_plan","start_date"],["sector_rank","date"],["sector_rank_proxy","date"],
  ["sentiment_daily","date"],["trading_calendar","date"],["valuation_daily","date"],["zt_pool","date"],["zt_proxy","date"],
  ["sw_industry_span","from_date"],["security_sector","ts"],["quote_snapshot","ts"],["signal_state","ts"],
  ["holder_change","start_date"],["job_run","date"],
];
console.log("源库快照到", SCRATCH);
{
  const src = openDb();
  const t0 = Date.now();
  src.exec(`VACUUM INTO '${SCRATCH}'`);
  console.log("快照完成，秒", Math.round((Date.now()-t0)/1000));
  src.close();
}
const db = openDb(SCRATCH);
runMigrations(db);

const snap = (D: string) => {
  const view = createSqliteView(db, `${D} 15:05:00`);
  try {
    const r = identifyMainlines(view, D, {});
    return r.mainlines.map(m=>`${m.source}|${m.name}|${m.limitUpCount}|${(m.pct ?? -999).toFixed(4)}`).sort().join("\n");
  } catch (e) {
    return `__ERR__:${(e as Error).message}`;
  }
};
console.log("\n取基线快照…");
const base = new Map<string,string>();
for (const D of DAYS) base.set(D, snap(D));

console.log("\n按日期从大到小逐次截断并比对");
console.log("检测日".padEnd(14), "删除行".padEnd(9), "主线数 全量/截断", "  结论");
let bad = 0;
for (const D of [...DAYS].sort().reverse()) {
  let del = 0;
  for (const [t,c] of TAB_DATE) {
    try { del += db.prepare(`DELETE FROM ${t} WHERE substr(${c},1,10) > ?`).run(D).changes; } catch { /* 缺列跳过 */ }
  }
  const after = snap(D);
  const before = base.get(D)!;
  const same = before === after;
  if (!same) bad++;
  const nf = before.startsWith("__ERR__") ? -1 : (before ? before.split("\n").length : 0);
  const na = after.startsWith("__ERR__") ? -1 : (after ? after.split("\n").length : 0);
  console.log(D.padEnd(14), String(del).padEnd(9), `${nf}/${na}`.padEnd(16), same ? "一致 ✓" : "**不一致 ✗**");
  if (!same) {
    if (before.startsWith("__ERR__") || after.startsWith("__ERR__")) {
      console.log("   全量侧:", before.slice(0,120)); console.log("   截断侧:", after.slice(0,120));
    } else {
      const a = new Set(before.split("\n")), b = new Set(after.split("\n"));
      for (const x of [...a].filter(v=>!b.has(v)).slice(0,5)) console.log("   仅全量有:", x);
      for (const x of [...b].filter(v=>!a.has(v)).slice(0,5)) console.log("   仅截断有:", x);
    }
  }
}
console.log(bad ? `\n>>> 检出 ${bad} 个日期的结果依赖未来数据` : "\n>>> 未检出未来函数：删掉未来数据后结果逐字一致");
db.close();
