/**
 * 影子盘重结算：按变体**当前**的离场器口径，把已经落定的结果重算一遍。
 *
 * 用法：
 *   pnpm shadow:resettle                    看哪些变体的结算口径过期了（只看，不改）
 *   pnpm shadow:resettle --apply            重结所有过期的变体
 *   pnpm shadow:resettle --apply <id> ...   只重结指名的变体（不管过没过期）
 *   可加 --as-of YYYY-MM-DD 指定结算的"今天"（缺省 = 库里最新一根日线）
 *
 * 为什么要有它：029 之前影子盘结算没跑离场器，只换了离场器的变体（r-exit-hard、hm-* 的游资纪律）
 * 结出来与 baseline 逐笔相同 —— 那些行是按错的口径结的，统计与毕业判定在重结之前把它们当"还没结"。
 * 幂等：重跑结果不变（settled_at 除外）；作废行不动；一个事务，中途出错整体回滚。
 * 缺省不碰口径没变的变体：K 线后来被修补过的话，重结会让 baseline 的数字漂。
 */
import { openDb } from "@/lib/db";
import { runMigrations } from "@/lib/db/migrate";
import { resettleShadow, staleExitVariants } from "@/lib/shadow/book";
// CLI 不读 .env.local（只有 next 会读），这里补上，免得在默认目录上新建/操作一个空库
import { loadCliEnv } from "@/lib/config";
loadCliEnv();

const argv = process.argv.slice(2);
const apply = argv.includes("--apply");
const asOfIdx = argv.indexOf("--as-of");
const asOfArg = asOfIdx >= 0 ? argv[asOfIdx + 1] : undefined;
if (asOfIdx >= 0 && (asOfArg === undefined || !/^\d{4}-\d{2}-\d{2}$/.test(asOfArg))) {
  console.error("--as-of 要跟一个 YYYY-MM-DD");
  process.exit(2);
}
const named = argv.filter((a, i) => !a.startsWith("--") && (asOfIdx < 0 || i !== asOfIdx + 1));

const db = openDb();
runMigrations(db);
try {
  const known = new Set((db.prepare("SELECT id FROM shadow_variant").all() as Array<{ id: string }>).map(r => r.id));
  const unknown = named.filter(v => !known.has(v));
  if (unknown.length > 0) throw new Error(`变体不存在：${unknown.join("、")}`);
  const stale = staleExitVariants(db);
  const targets = named.length > 0 ? named : stale;
  console.log(`离场口径过期的变体：${stale.length === 0 ? "无" : stale.join("、")}`);
  if (!apply) {
    if (targets.length > 0) console.log(`加 --apply 重结：${targets.join("、")}`);
  } else if (targets.length === 0) {
    console.log("没有要重结的变体");
  } else {
    const asOf = asOfArg ?? (db.prepare("SELECT MAX(date) AS d FROM kline_daily").get() as { d: string | null }).d;
    if (asOf === null) throw new Error("库里没有日线");
    const t0 = Date.now();
    const r = resettleShadow(db, asOf, targets);
    console.log(`重结 ${targets.join("、")}（截至 ${asOf}）：删旧 ${r.removed} 条 → 已结算 ${r.settled}、未触发 ${r.untriggered}、` +
      `待定 ${r.pending}、离场器出错 ${r.failed}（${Math.round((Date.now() - t0) / 1000)} 秒）`);
  }
} catch (e) {
  console.error((e as Error).message);
  process.exitCode = 1;
} finally {
  db.close();
}
