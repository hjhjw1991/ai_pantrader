import { shanghaiDay, shanghaiTs } from "@/lib/data/clock";

/**
 * 时间戳口径适配。
 *
 * 全库口径是**上海挂钟** `YYYY-MM-DD HH:MM:SS.mmm`（lib/data/clock.ts，migration 006）。
 * 但库里仍可能有 migration 006 之前写下的 UTC ISO 串（`...T07:10:49.052Z`）——
 * 006 只转它跑过的那一刻，之后没被采集覆盖到的老行会一直是老格式，
 * 而未升级的库（前端只读，不能替它跑 migration）里全都是老格式。
 *
 * 所以显示层必须**两种都认**。认错的后果不是差 8 小时那么简单：
 * 一个 07:10 的 UTC 串被当成挂钟时间显示，就成了"早上 7:10 的快照"，
 * 看上去像盘前数据，实际是收盘价 —— 拿它当"现价"做判断会直接下错单。
 *
 * 转换直接复用 clock.ts，不在这里重写一份格式化：口径只能有一处。
 */

export { shanghaiTs, shanghaiDay };

const UTC_MARKED = /(?:Z|[+-]\d{2}:?\d{2})$/;
const SHANGHAI_OFFSET_MS = 8 * 3600 * 1000;

/** 归一成上海挂钟串。非法输入返回 null —— 不猜，也不回落到"现在" */
export function toShanghaiWall(ts: string | null | undefined): string | null {
  if (typeof ts !== "string") return null;
  const s = ts.trim();
  if (!/^\d{4}-\d{2}-\d{2}/.test(s)) return null;
  if (s.length === 10) return `${s} 00:00:00`;
  if (UTC_MARKED.test(s)) {
    const ms = Date.parse(s);
    if (!Number.isFinite(ms)) return null;
    return shanghaiTs(new Date(ms));
  }
  // 已经是挂钟串（分钟线/板块榜/006 之后的写入），只统一分隔符
  return s.replace("T", " ");
}

/**
 * 归一成绝对时刻（epoch ms），用于算数据新鲜度。
 *
 * 挂钟串按 +08:00 解释，**不按本机时区** —— 本机不在 +08 时
 * `new Date("2026-08-03 15:10:49")` 会偏出好几个小时，
 * 而"快照是否陈旧"这个判断偏了就等于告警失效。
 */
export function dbTsToMs(ts: string | null | undefined): number | null {
  if (typeof ts !== "string") return null;
  const s = ts.trim();
  if (UTC_MARKED.test(s)) {
    const ms = Date.parse(s);
    return Number.isFinite(ms) ? ms : null;
  }
  const wall = toShanghaiWall(s);
  if (wall === null) return null;
  const ms = Date.parse(`${wall.replace(" ", "T")}Z`);
  return Number.isFinite(ms) ? ms - SHANGHAI_OFFSET_MS : null;
}
