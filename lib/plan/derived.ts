import type { Db } from "@/lib/db";
import { createSqliteView, SENTIMENT_COLUMNS } from "@/lib/pit/sqlite-view";
import { sentimentSnapshot, SENTIMENT_ALGO_VERSION } from "@/lib/factors/sentiment";
import { tradingDaysBetween } from "@/lib/data/calendar";
import { addDays, shanghaiTs } from "@/lib/data/clock";

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
 * 夜间任务的派生表入口（注入给 JobDeps.buildDerived）。
 * 看近 20 个自然日：覆盖"连着几晚没跑"与长假，更早的交给回补脚本。
 */
export function runNightlyDerived(db: Db, date: string): Record<string, number> {
  const r = buildSentiment(db, { from: addDays(date, -20), to: date });
  return { sentimentBuilt: r.built, sentimentKept: r.kept, sentimentThin: r.thin };
}
