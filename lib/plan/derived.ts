import type { Db } from "@/lib/db";
import { createSqliteView, SENTIMENT_COLUMNS } from "@/lib/pit/sqlite-view";
import { sentimentSnapshot, SENTIMENT_ALGO_VERSION } from "@/lib/factors/sentiment";
import { crossSectionProxy, CROSS_PROXY_VERSION } from "@/lib/factors/cross-proxy";
import { tradingDaysBetween } from "@/lib/data/calendar";
import { addDays, shanghaiTs } from "@/lib/data/clock";
import { runSwitchCycle } from "@/lib/shadow/switch";
import { settleShadowPending } from "@/lib/shadow/book";

export interface BuildSentimentOpts {
  from: string;
  to: string;
  /**
   * 区间末尾这么多个交易日**无条件重算**。日线偶尔隔天被修正（停牌票补录、复权因子回改），
   * 已建好的最近几行可能是按错的日线算的。默认 3。
   */
  rebuildRecent?: number;
  /** 全部重算，不看已有行 */
  force?: boolean;
  onDay?: (date: string, built: boolean) => void;
}

export interface BuildSentimentResult {
  built: number;
  /** 已是当前口径、无需重算 */
  kept: number;
  /** 那天日线覆盖不足，没写行 */
  thin: number;
}

/**
 * 日线覆盖低于这个比例的交易日不建行：那种截面算出来的晋级率与溢价
 * 只反映"碰巧采到的那部分票"，写进去会污染分位序列。宁可空着，因子如实报"未构建"。
 */
const MIN_COVERAGE = 0.5;

/**
 * 重建情绪截面派生表。
 *
 * 每天在 "那天 15:05" 的时点视图下算 —— 与策略在那天收盘后看到的数据完全一致，
 * 所以派生表不会比实时评估多看到任何东西。
 */
export function buildSentiment(db: Db, o: BuildSentimentOpts): BuildSentimentResult {
  const days = tradingDaysBetween(db, o.from, o.to);
  const have = new Map(
    (db.prepare("SELECT date, algo_version FROM sentiment_daily WHERE date >= ? AND date <= ?")
      .all(o.from, o.to) as Array<{ date: string; algo_version: string }>)
      .map(r => [r.date, r.algo_version])
  );
  const recent = new Set(days.slice(Math.max(0, days.length - (o.rebuildRecent ?? 3))));
  const cols = SENTIMENT_COLUMNS.map(([c]) => c);
  const ins = db.prepare(
    `INSERT OR REPLACE INTO sentiment_daily (${cols.join(", ")}, algo_version, built_at)
     VALUES (${cols.map(() => "?").join(", ")}, ?, ?)`
  );

  let built = 0, kept = 0, thin = 0;
  for (const d of days) {
    if (!o.force && !recent.has(d) && have.get(d) === SENTIMENT_ALGO_VERSION) { kept++; continue; }
    const snap = sentimentSnapshot(createSqliteView(db, `${d} 15:05:00`), d);
    const total = snap.up + snap.down + snap.flat + snap.unknown;
    if (total === 0 || snap.unknown / total > 1 - MIN_COVERAGE) {
      thin++;
      o.onDay?.(d, false);
      continue;
    }
    ins.run(...SENTIMENT_COLUMNS.map(([, k]) => snap[k]), SENTIMENT_ALGO_VERSION, shanghaiTs());
    built++;
    o.onDay?.(d, true);
  }
  return { built, kept, thin };
}

/**
 * 重建代理截面（涨停名单 + 申万三级行业涨幅榜）。按天整批替换，与情绪表同一套增量规则。
 *
 * 覆盖不足的日子（那天日线还没采全）不建：半个市场的涨停名单会让主线识别只看见一半。
 * 判断口径与情绪表一致 —— 直接看那天情绪表有没有行，没有就说明日线覆盖不够，这天跳过。
 */
export function buildCrossProxy(db: Db, o: BuildSentimentOpts): BuildSentimentResult {
  const days = tradingDaysBetween(db, o.from, o.to);
  const have = new Map(
    (db.prepare("SELECT date, algo_version FROM cross_proxy_built WHERE date >= ? AND date <= ?")
      .all(o.from, o.to) as Array<{ date: string; algo_version: string }>).map(r => [r.date, r.algo_version])
  );
  const covered = new Set(
    (db.prepare("SELECT date FROM sentiment_daily WHERE date >= ? AND date <= ?").all(o.from, o.to) as Array<{ date: string }>)
      .map(r => r.date)
  );
  const recent = new Set(days.slice(Math.max(0, days.length - (o.rebuildRecent ?? 3))));
  const delZ = db.prepare("DELETE FROM zt_proxy WHERE date = ?");
  const delS = db.prepare("DELETE FROM sector_rank_proxy WHERE date = ?");
  const insZ = db.prepare("INSERT INTO zt_proxy (date, code, lbc, sector) VALUES (?, ?, ?, ?)");
  const insS = db.prepare("INSERT INTO sector_rank_proxy (date, sector, pct, leader_code, members) VALUES (?, ?, ?, ?, ?)");
  const mark = db.prepare("INSERT OR REPLACE INTO cross_proxy_built (date, algo_version, built_at) VALUES (?, ?, ?)");

  let built = 0, kept = 0, thin = 0;
  for (const d of days) {
    if (!o.force && !recent.has(d) && have.get(d) === CROSS_PROXY_VERSION) { kept++; continue; }
    if (!covered.has(d)) { thin++; o.onDay?.(d, false); continue; }
    const p = crossSectionProxy(createSqliteView(db, `${d} 15:05:00`), d);
    db.transaction(() => {
      delZ.run(d); delS.run(d);
      for (const z of p.zt) insZ.run(z.date, z.code, z.lbc, z.sector);
      for (const x of p.sectors) insS.run(x.date, x.sector, x.pct, x.leaderCode, x.members);
      mark.run(d, CROSS_PROXY_VERSION, shanghaiTs());
    })();
    built++;
    o.onDay?.(d, true);
  }
  return { built, kept, thin };
}

/**
 * 夜间任务的派生表入口（注入给 JobDeps.buildDerived）。
 * 看近 20 个自然日：覆盖"连着几晚没跑"与长假，更早的交给回补脚本。
 */
export function runNightlyDerived(db: Db, date: string): Record<string, number> {
  const r = buildSentiment(db, { from: addDays(date, -20), to: date });
  // 代理截面依赖情绪表判断覆盖，所以排在它后面
  let c = { built: 0, kept: 0, thin: 0 }, crossFailed = 0;
  try { c = buildCrossProxy(db, { from: addDays(date, -20), to: date }); }
  catch (e) { crossFailed = 1; console.error(`[night] 代理截面重建失败：${(e as Error).message}`); }
  /**
   * 影子盘结算也挂在这里：它要今晚刚落库的日线，而且和派生表一样是纯本地计算。
   * 放在情绪表之后 —— 结算失败不该连累派生表，所以各自兜底。
   */
  let s = { settled: 0, untriggered: 0, pending: 0 }, shadowFailed = 0;
  try { s = settleShadowPending(db, date); }
  catch (e) { shadowFailed = 1; console.error(`[night] 影子盘结算失败：${(e as Error).message}`); }
  /**
   * 结算完再看毕业：今晚刚结的样本要算进去。切换改的是策略文件，明天 09:15 的盘前计划起生效。
   * 失败只留声 —— 毕业判定出错不能拖垮派生表与结算。
   */
  let sw = "none", switchFailed = 0;
  try { sw = runSwitchCycle(db).action; }
  catch (e) { switchFailed = 1; console.error(`[night] 影子盘毕业判定失败：${(e as Error).message}`); }
  return {
    switchProposed: sw === "proposed" ? 1 : 0, switchApplied: sw === "applied" ? 1 : 0, switchFailed,
    sentimentBuilt: r.built, sentimentKept: r.kept, sentimentThin: r.thin,
    crossProxyBuilt: c.built, crossProxyThin: c.thin, crossProxyFailed: crossFailed,
    shadowSettled: s.settled, shadowUntriggered: s.untriggered, shadowPending: s.pending, shadowFailed,
  };
}
