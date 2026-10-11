import type { Db } from "@/lib/db";
import { liveIntradayWatch } from "@/lib/data/intraday-watch";

/**
 * 盘中分钟线采哪些票。
 *
 * 这一版替换掉 M0 占位：原来取 `security` 表按代码排序的前 50 只，
 * 实测那一批是 000001~000059 的深市老票，里面混着 PT金田A / 国华退 / PT中浩A /
 * 神城A退 / 新都退 / 大通退 —— 多半只有 240 根（一天的量）就再也取不到数了。
 * 而**真正要盯的票一只都不在里面**：观察池 5 只、持仓 3 只、今日计划点名的 3 只，
 * 没有一个落在前 50 里。等于每天 48 轮、每轮 50 个请求全花在与任何判断无关的票上。
 *
 * 池子 = 自选 ∪ 持仓 ∪ 盘中候选 ∪ 今日计划点名的票：
 *   - 自选：人点名要盯的
 *   - 持仓：离场判断要看盘中形状
 *   - 盘中候选：系统这一轮点名要盯的（intraday_watch，**掉出候选就停采**）
 *   - 今日计划：盘前写进 prediction 的候选与持仓动作
 *
 * 后两条看着像重复，其实是两回事：计划是早上那一版候选的快照，写下去就定死；
 * 盘中候选每 5 分钟重算一次，管的是"10:40 才冒出来的票"，也管"已经不满足
 * 条件的票该停了"。计划那条**不**跟着掉出 —— 早上写进台账的是当天的一个承诺，
 * 中途退出候选仍然要看它盘中走到哪（触发价到底碰没碰到）。
 *
 * 不再保留"前 50 只"兜底。凭什么替人挑 50 只票？挑出来也跟任何判断无关，
 * 只是白烧限频 —— 分钟线每只票一个请求，盘中 48 轮。
 *
 * 上限是保护，不是设计目标：候选多的时候不让它把一轮拖到几十秒。
 * 真被截断时数字会进 stats，看得见。
 */

export const MINUTE_POOL_MAX = 120;

export interface WatchPool {
  codes: string[];
  /** 各来源分别多少只，进 stats：池子空的时候要能看出是"没自选"还是"今天没候选" */
  fromWatch: number;
  fromHeld: number;
  fromIntraday: number;
  fromPlan: number;
  /** 超过上限被截掉多少只 */
  truncated: number;
}

/**
 * 当日分钟线池。去重保序：自选在最前（人点名的优先拿到额度），
 * 其次持仓，再是盘中候选（系统此刻点名），最后才是盘前计划 ——
 * 真到了要截断的时候，砍的是早上那版快照里已经过时的部分。
 */
export function watchPool(db: Db, date: string, max: number = MINUTE_POOL_MAX): WatchPool {
  const watch = db
    .prepare(`SELECT code FROM watchpool WHERE active = 1 ORDER BY added_at`)
    .all()
    .map((r: any) => String(r.code));
  const held = db
    .prepare(`SELECT DISTINCT code FROM position WHERE qty > 0`)
    .all()
    .map((r: any) => String(r.code));
  // 这一轮还在候选池里的。掉出的（active=0）不算 —— 见 intraday-watch 的说明
  const live = liveIntradayWatch(db, date);
  // prediction 的 ts 是上海挂钟 "YYYY-MM-DD HH:MM:SS"，按日期前缀取当天
  const planned = db
    .prepare(`SELECT DISTINCT code FROM prediction WHERE substr(ts, 1, 10) = ?`)
    .all(date)
    .map((r: any) => String(r.code));

  const seen = new Set<string>();
  const codes: string[] = [];
  for (const c of [...watch, ...held, ...live, ...planned]) {
    if (seen.has(c)) continue;
    seen.add(c);
    codes.push(c);
  }
  const truncated = Math.max(0, codes.length - max);
  return {
    codes: codes.slice(0, max),
    fromWatch: watch.length,
    fromHeld: held.length,
    fromIntraday: live.length,
    fromPlan: planned.length,
    truncated,
  };
}
