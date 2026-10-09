/**
 * 全库统一的时间戳口径：上海挂钟时间 `YYYY-MM-DD HH:MM:SS`。
 *
 * 为什么必须统一，以及为什么选上海时间而不是 UTC：
 *
 * 之前 quote_snapshot 写 `new Date().toISOString()`（`2026-08-03T07:10:49.052Z`），
 * 而分钟线/板块榜写数据源给的上海挂钟时间（`2026-08-03 14:55:00`）。两种格式混在
 * 同一套 `WHERE ts <= ?` 比较里，问题比"差 8 小时"更糟：字符串比较下 `T`(0x54)
 * 恒大于空格(0x20)，所以带 T 的那条永远排在后面，跟真实时间无关。
 * PointInTimeView 的防未来函数保证会被这个格式差异直接击穿。
 *
 * 选上海时间：A 股的交易日、集合竞价、收盘时点全是上海挂钟定义的。用 UTC 存，
 * 09:25 的集合竞价会落到 01:25，凌晨写入的快照还会掉到前一个 UTC 日期上，
 * 让"当日快照"这种最基本的查询变成陷阱。数据源本来也给的是上海时间。
 *
 * 代价（明确记下来）：本机时区若不是 +08:00，这里也照样输出上海时间，
 * 不受本机 TZ 影响 —— 这正是要的行为。
 */

const FMT = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Shanghai",
  year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit",
  hour12: false,
});

/**
 * `YYYY-MM-DD HH:MM:SS.mmm`（上海）。全库时间戳一律走这里，别再直接用 toISOString。
 *
 * 为什么带毫秒：source_health 的主键是 (source, ts)，一秒内可以记多条健康记录。
 * 只保留到秒会让它们撞主键 —— 迁移历史数据时就撞了
 * （UNIQUE constraint failed: source_health.source, source_health.ts）。
 *
 * 毫秒不影响与分钟线那种 `YYYY-MM-DD HH:MM:SS` 的比较：前缀相同，
 * `14:47:41.774` 落在 `14:47:41` 与 `14:47:42` 之间，正是想要的顺序。
 * 全库一个格式，不留"这张表带毫秒那张表不带"的例外给以后的人踩。
 */
export function shanghaiTs(d: Date = new Date()): string {
  const p: Record<string, string> = {};
  for (const { type, value } of FMT.formatToParts(d)) p[type] = value;
  // en-CA 的 hour12:false 在部分 ICU 版本上把午夜给成 24，规范化回 00
  const hh = p.hour === "24" ? "00" : p.hour;
  const ms = String(d.getMilliseconds()).padStart(3, "0");
  return `${p.year}-${p.month}-${p.day} ${hh}:${p.minute}:${p.second}.${ms}`;
}

/** `YYYY-MM-DD`（上海） */
export function shanghaiDay(d: Date = new Date()): string {
  return shanghaiTs(d).slice(0, 10);
}

/**
 * 上海时区的星期几（0=周日 … 6=周六）。
 *
 * 不用 Date.getDay()：那读的是**运行机器的本地时区**。
 * 机器设在别的时区时，22:00 CST 的那一刻本地可能已经是次日，
 * "周五夜跑周复盘"会悄悄变成周六 —— 不报错，只是永远错开一天。
 * 从上海挂钟日期反推，与全库其它日期口径一致。
 */
export function shanghaiWeekday(d: Date = new Date()): number {
  const [y, m, dd] = shanghaiDay(d).split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, dd)).getUTCDay();
}

/** `YYYY-MM-DD` 加减自然日。跨月跨年交给 Date 的 UTC 算术，不手写进位 */
export function addDays(date: string, n: number): string {
  const [y, m, d] = date.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, "0")}-${String(t.getUTCDate()).padStart(2, "0")}`;
}

/**
 * 集合竞价撮合时刻（上海）。开盘价就是这一刻定出来的。
 *
 * 结算口径"成交日最低价 ≤ 触发价即成交、价 = min(开盘, 触发价)"隐含了一个前提：
 * 单子在这一刻**之前**就挂上了。晚于它才做的决定，开盘价与之前的盘中低点都已经
 * 是过去式 —— 拿它们结算等于让策略"回到过去下单"（见 isLateDecision）。
 */
export const AUCTION_MATCH = "09:25:00";

/**
 * 任意时间戳 → 上海挂钟 `YYYY-MM-DD HH:MM:SS`（截到秒）。
 *
 * 库里的决策时刻有两种写法：全库口径的上海挂钟串（shanghaiTs），
 * 与老台账 / 测试里带偏移的 ISO 串（`2026-08-03T15:30:00+08:00`、`...Z`）。
 * 带偏移或 Z 的按时区换算；不带的视为已经是上海挂钟，只把 T 换成空格。
 * 只有日期的视为当天 00:00:00。
 */
export function toShanghaiWall(ts: string): string {
  const s = ts.trim();
  if (/(?:z|[+-]\d{2}:?\d{2})$/i.test(s) && s.length > 10) {
    const ms = Date.parse(s);
    if (!Number.isNaN(ms)) return shanghaiTs(new Date(ms)).slice(0, 19);
  }
  const wall = s.replace("T", " ").slice(0, 19);
  return wall.length === 10 ? `${wall} 00:00:00` : wall;
}

/** 作废行的说明。影子盘（shadow_outcome.note）与台账（outcome.attribution）用同一句 */
export const LATE_DECISION_NOTE = "决策晚于成交日 09:25，开盘前的价格不可得";

/**
 * 决策是否晚于成交日的集合竞价撮合（含等于）。是 → 这笔预测作废，不进任何统计。
 *
 * 实测场景：机器 11:00 才醒，09:15 的盘前计划 catchUp 到 11:00 才跑，
 * 而结算仍按成交日整天的开盘 / 最低价算 —— 开盘前就已经发生的成交被记到了它头上。
 * 用户 2026-10-09 选定：这种样本作废，不计入胜率、毕业与报表，只在列表里留痕。
 */
export function isLateDecision(decidedAt: string, fillDate: string): boolean {
  return toShanghaiWall(decidedAt) >= `${fillDate} ${AUCTION_MATCH}`;
}
