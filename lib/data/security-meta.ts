import type { Db } from "@/lib/db";

/**
 * 新浪日线一次最多 1023 根。取到的根数是否触顶，决定了第一根 bar 能不能当上市日用。
 * 改这个常量前先看 lib/data/sources/sina.ts 的 MAX_DATALEN，两边必须一致。
 */
export const SINA_MAX_BARS = 1023;

export interface SecurityMetaReport {
  scanned: number;
  /** 能严格确定上市日的（本地序列未被截断） */
  listDateResolved: number;
  /** 被 datalen 截断，只能给下界 */
  windowCapped: number;
  /** 当前名称带 ST 标记、据此播种观测起点的 */
  stObserved: number;
}

/** 名称里的 ST 标记。*ST 是退市风险警示，ST 是其他风险警示，两者涨跌幅都是 5%。 */
function isStName(name: string): boolean {
  return /(^|\s)\*?ST/i.test(name) || name.includes("ST");
}

/**
 * 从已落库的日线反推 security 元数据。不发网络请求 ——
 * 东财 clist 会整体限流，而这些字段是回测正确性的前提，不能等源恢复。
 *
 * 严格性优先于覆盖率：填不出来就留 NULL。写一个猜的上市日比留空危险得多，
 * 因为幸存者偏差过滤会拿它当真值用，错了不会报错，只会让回测收益虚高。
 */
export function deriveSecurityMeta(db: Db): SecurityMetaReport {
  const rows = db.prepare(
    `SELECT code, COUNT(*) n, MIN(date) fb FROM kline_daily GROUP BY code`
  ).all() as Array<{ code: string; n: number; fb: string }>;

  const upd = db.prepare(
    `UPDATE security SET first_bar_date = ?, bar_count = ?, list_date = COALESCE(?, list_date)
     WHERE code = ?`
  );

  let listDateResolved = 0, windowCapped = 0;

  db.transaction(() => {
    for (const r of rows) {
      // 未触顶 = 拿到了整条序列 = 第一根就是上市日；触顶则真实上市日更早，只能留 NULL
      const genuine = r.n < SINA_MAX_BARS;
      upd.run(r.fb, r.n, genuine ? r.fb : null, r.code);
      if (genuine) listDateResolved++; else windowCapped++;
    }
  })();

  return {
    scanned: rows.length,
    listDateResolved,
    windowCapped,
    stObserved: seedStObservation(db),
  };
}

/**
 * 用当前名称播种 ST 观测起点。
 *
 * 诚实边界：这**不是** ST 历史，只是"从今天起观测到它是 ST"。
 * ST 状态随时间变化，判断 2022 年某天是否 ST 需要历史名称，本地没有这份数据。
 *
 * 为什么仍然值得写：对过去的日期，查询结果依旧是"非 ST"（和现在完全一样，没变坏），
 * 对今天及以后则变成正确的 ST。是严格的改进，不引入新的错误方向。
 * 真正的历史只能从上线起逐日积累 —— 和快照一样，是攒出来的资产。
 */
export function seedStObservation(db: Db): number {
  const rows = db.prepare(
    `SELECT code, name, is_st_history_json FROM security WHERE name IS NOT NULL`
  ).all() as Array<{ code: string; name: string; is_st_history_json: string | null }>;

  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());

  const upd = db.prepare(`UPDATE security SET is_st_history_json = ? WHERE code = ?`);
  let n = 0;

  db.transaction(() => {
    for (const r of rows) {
      if (!isStName(r.name)) continue;
      // 已经有观测记录就不动，避免每次跑都把起点刷成今天
      if (r.is_st_history_json) continue;
      upd.run(JSON.stringify([{ from: today, to: null }]), r.code);
      n++;
    }
  })();

  return n;
}
