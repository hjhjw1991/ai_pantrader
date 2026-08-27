/**
 * 因子层公用的数值与参数工具。
 *
 * 这里的每个函数都必须是纯的：不碰网络、不碰存储、不取系统时间。
 * "现在"一律来自 ctx.view.asOf（spec §4.2）。
 */
import type { DailyBar, PointInTimeView } from "@/lib/contracts";

export function sum(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0);
}

export function mean(xs: number[]): number {
  return xs.length === 0 ? 0 : sum(xs) / xs.length;
}

/**
 * 总体标准差（除以 n）。布林带的行业惯例是总体标准差，
 * 用样本标准差（n-1）算出来的带宽会比行情软件宽一点，回测与看盘会对不上。
 */
export function stdevPop(xs: number[]): number {
  if (xs.length === 0) return 0;
  const m = mean(xs);
  return Math.sqrt(mean(xs.map(x => (x - m) ** 2)));
}

export function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

/**
 * 因子输出统一定点到 6 位小数。
 * 原因是 spec §17 断言 4：同份输入跑两次回测结果哈希必须一致。
 * 浮点尾差本身是确定性的，但一旦下游做求和/排序，尾差会放大成排名抖动，
 * 定点是最省事的护栏。
 */
export function round6(x: number): number {
  return Math.round(x * 1e6) / 1e6;
}

/** 复权后收盘价。不同日期的价格要比较，必须先过这一层（spec R1） */
export function adjClose(b: DailyBar): number {
  return b.c * (b.adjFactor ?? 1);
}

/** 涨跌幅，单位百分点（9.9 表示 +9.9%） */
export function pctChange(prev: number, cur: number): number {
  if (!Number.isFinite(prev) || prev === 0) return 0;
  return (cur / prev - 1) * 100;
}

export function lastOf<T>(xs: T[]): T | null {
  return xs.length === 0 ? null : xs[xs.length - 1];
}

/**
 * 截至 date（含）的最近 n 根日线。
 *
 * view.dailyBars 的语义是"截至 asOf"，而因子有时要评估一个更早的日期
 * （回放、连板回溯）。这里多拉一段再切，pull 必须大于 date 到 asOf 之间的交易日数，
 * 否则会切出空数组 —— 所以 pull 默认给足余量。
 */
export function barsUpTo(
  view: PointInTimeView, code: string, date: string, n: number, pull = n + 60
): DailyBar[] {
  const all = view.dailyBars(code, pull).filter(b => b.date <= date);
  return all.slice(Math.max(0, all.length - n));
}

/* ------------------------------- 参数读取 ------------------------------- */

export function pnum(params: Record<string, unknown>, key: string, dflt: number): number {
  const v = params[key];
  return typeof v === "number" && Number.isFinite(v) ? v : dflt;
}

export function pstr(params: Record<string, unknown>, key: string, dflt: string): string {
  const v = params[key];
  return typeof v === "string" && v.length > 0 ? v : dflt;
}

export function pbool(params: Record<string, unknown>, key: string, dflt: boolean): boolean {
  const v = params[key];
  return typeof v === "boolean" ? v : dflt;
}

export function parr(params: Record<string, unknown>, key: string): string[] {
  const v = params[key];
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

export function pobj(params: Record<string, unknown>, key: string): Record<string, unknown> {
  const v = params[key];
  return v !== null && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};
}

/**
 * 个股因子的标的从 params.code 取 —— FactorContext 只有 { view, params }，
 * 没有 code 形参。取不到就抛错：静默返回 0 会被策略层当成"该票没信号"，
 * 而不是"配置写漏了"。
 */
export function requireCode(params: Record<string, unknown>, factorName: string): string {
  const v = params["code"];
  if (typeof v !== "string" || v.length === 0) {
    throw new Error(`因子 ${factorName} 需要 params.code`);
  }
  return v;
}

/**
/** 因子求值的日期：默认视图时点，允许参数指定更早的日期用于回放 */
export function evalDate(view: PointInTimeView, params: Record<string, unknown>): string {
  const d = params["日期"];
  return typeof d === "string" && d.length > 0 && d <= view.asOf ? d : view.asOf;
}
