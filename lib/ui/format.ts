import { dbTsToMs, toShanghaiWall } from "@/lib/ui/time";
import { shanghaiDay } from "@/lib/data/clock";

/**
 * 纯格式化。唯一的硬规则：**没有数据就显示破折号，不显示 0**。
 *
 * 0 在交易界面里是一个有意义的数值（平盘、零仓位、零净买额）。
 * 把缺失渲染成 0 就是把"不知道"伪装成"知道"，用户会照着它下单。
 */

export const DASH = "—";

export function isNum(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/** 价格：A股两位小数够用，科创/北交所也是两位报价 */
export function fmtPx(v: number | null | undefined, digits = 2): string {
  return isNum(v) ? v.toFixed(digits) : DASH;
}

/** 涨跌幅。入参是百分数（5.2 表示 +5.2%），不是小数 */
export function fmtPct(v: number | null | undefined, digits = 2): string {
  if (!isNum(v)) return DASH;
  const s = v.toFixed(digits);
  return v > 0 ? `+${s}%` : `${s}%`;
}

/** 比例。入参是小数（0.35 表示 35%） */
export function fmtRatio(v: number | null | undefined, digits = 1): string {
  return isNum(v) ? `${(v * 100).toFixed(digits)}%` : DASH;
}

/** 金额：元 → 万/亿。封单额动辄上亿，原始数字扫一眼数不清位数 */
export function fmtAmount(v: number | null | undefined): string {
  if (!isNum(v)) return DASH;
  const neg = v < 0;
  const a = Math.abs(v);
  let s: string;
  if (a >= 1e8) s = `${(a / 1e8).toFixed(2)}亿`;
  else if (a >= 1e4) s = `${(a / 1e4).toFixed(0)}万`;
  else s = a.toFixed(0);
  return neg ? `-${s}` : s;
}

export function fmtQty(v: number | null | undefined): string {
  return isNum(v) ? v.toLocaleString("en-US") : DASH;
}

export function fmtInt(v: number | null | undefined): string {
  return isNum(v) ? String(Math.round(v)) : DASH;
}

/**
 * 时间戳显示。库里两种口径都可能出现（上海挂钟串 / 006 之前的 UTC ISO），
 * 归一交给 lib/ui/time.ts，这里只负责裁剪。一律显示上海时间 ——
 * 把 UTC 串当挂钟显示会让收盘快照看起来像盘前数据。
 */
export function fmtTs(ts: string | null | undefined, withDate = false): string {
  if (!ts) return DASH;
  const wall = toShanghaiWall(ts);
  if (wall === null) return ts;
  const time = wall.slice(11, 19);
  if (!withDate) return time;
  return `${wall.slice(5, 7)}/${wall.slice(8, 10)} ${time}`;
}

/**
 * 通知列表的时间。
 *
 * 只有 HH:MM:SS 是不够的：隔夜之后铃铛里三条通知并排，看不出哪条是今天早上
 * 的、哪条是上周的 —— 而"什么时候说的"往往就是这条通知还有没有用的全部依据
 * （三小时前的买入提醒，现在多半已经不在买点上了）。
 *
 * 阶梯式压缩：今天/昨天用相对说法（最高频，最短），同年省掉年份，跨年才带全。
 * 日期一律按**上海日**判定，不按本机时区 —— 海外时区看盘时取本机日期会整体错一天。
 */
export function fmtNoticeTs(ts: string | null | undefined, now: Date = new Date()): string {
  if (!ts) return DASH;
  const wall = toShanghaiWall(ts);
  if (wall === null) return ts;    // 认不出来的格式原样显示，不许伪造
  const time = wall.slice(11, 19);
  const day = wall.slice(0, 10);
  const today = shanghaiDay(now);
  if (day === today) return `今天 ${time}`;
  if (day === shiftDay(today, -1)) return `昨天 ${time}`;
  // 同年只留 月/日，跨年必须带年份
  const date = day.slice(0, 4) === today.slice(0, 4)
    ? `${day.slice(5, 7)}/${day.slice(8, 10)}`
    : day.replace(/-/g, "/");
  return `${date} ${time}`;
}

/** 日期串加减天数。按 UTC 整天算术，避开了本地时区的夏令时缺口 */
function shiftDay(day: string, deltaDays: number): string {
  const t = Date.parse(`${day}T00:00:00Z`) + deltaDays * 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
}

export function fmtDate(d: string | null | undefined): string {
  return d ?? DASH;
}

/**
 * 涨跌方向的 CSS 类。**红涨绿跌**（中国市场惯例）。
 * 返回完整字面量而不是拼接，PostCSS 的类名扫描器只认字面量。
 */
export function dirClass(v: number | null | undefined): string {
  if (!isNum(v) || v === 0) return "text-flat";
  return v > 0 ? "text-up" : "text-down";
}

export function gearClass(gear: string | null | undefined): string {
  if (gear === "进攻") return "text-gear-attack";
  if (gear === "中性") return "text-gear-neutral";
  if (gear === "防守") return "text-gear-defend";
  return "text-ink-3";
}

/** 数据新鲜度，分钟。挂钟串按 +08:00 解释，不按本机时区（见 lib/ui/time.ts） */
export function ageMinutes(ts: string | null | undefined, now: Date = new Date()): number | null {
  const t = dbTsToMs(ts);
  if (t === null) return null;
  return (now.getTime() - t) / 60000;
}

export function fmtAge(mins: number | null): string {
  if (mins === null) return DASH;
  if (mins < 1) return "刚刚";
  if (mins < 60) return `${Math.floor(mins)}分钟前`;
  if (mins < 60 * 24) return `${Math.floor(mins / 60)}小时前`;
  return `${Math.floor(mins / 1440)}天前`;
}
