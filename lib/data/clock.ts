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
