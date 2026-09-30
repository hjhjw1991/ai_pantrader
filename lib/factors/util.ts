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

/**
 * 前复权的**归一基准**：序列里最大的那个复权因子，而不是最后一根的。
 *
 * ── 为什么不能拿最后一根 ──
 *
 * 最后一根只有"这次采集写对了"才可信。而它恰好是最容易写坏的一根：日线采集是
 * 常驻进程做的，进程的代码冻结在它启动的那一刻（见 scripts/daemon.ts 的守卫注释），
 * 修好了 daily.ts 但没重启采集进程的话，新交易日插进来的那根就是上一版逻辑写的 ——
 * 实测 2026-09-28 / 09-29 连续两天全市场 5,540 行的 adj_factor 全是 1.0。
 *
 * 后果不是"最新一根偏一点"：**历史整段按真实价的 5.8 倍显示**（太极实业 600667
 * 实测 9-24 真实收盘 19.41，图上 112.65）。前复权价 = 后复权价 ÷ 基准因子，
 * 基准被写成 1，等于没归一化 —— 一张图全错，而且错得很像"这票以前很贵"。
 *
 * ── 为什么取最大值是对的 ──
 *
 * 复权因子是**单调递增的台阶**：两次除权之间恒定，除权后变大，不会从非 1 退回 1。
 * 所以"序列里的最大值"正常情况下就等于最后一根的值；只有当最后一根被写坏成 1.0 时，
 * 最大值才会落在上一根 —— 那正是我们想要的那个基准。
 *
 * 反过来说，从没除过权的票整段都是 1.0，最大值也是 1.0，不会被误判。
 *
 * @returns 基准因子；序列为空或一根可用因子都没有时返回 0（调用方按"不可换算"处理，
 *          不要退化成 1 —— 那会把后复权价当成前复权价显示，错得更安静）
 */
export function baseAdjFactor(bars: ReadonlyArray<{ adjFactor?: number | null }>): number {
  let max = 0;
  for (const b of bars) {
    const a = typeof b.adjFactor === "number" && Number.isFinite(b.adjFactor) ? b.adjFactor : 0;
    if (a > max) max = a;
  }
  return max;
}

/**
 * 把因子 = 1.0 却位于"非 1 台阶之后"的行，顺延成前一交易日的因子。
 *
 * 这是 `repairTrailingAdjFactors`（写侧的幂等自愈）在**读侧**的对应物。
 * 写侧自愈只能修复"跑着新代码的那个进程写出来的东西"：负责日线的是常驻 daemon，
 * 它的代码冻结在启动那一刻（scripts/daemon.ts 的新鲜度守卫就是为了治这个），
 * 所以只要有人改了采集层却没重启它，库里就会持续产生坏行 —— 读侧不能假设库是干净的。
 *
 * 两个都不多余：写侧让数据恢复正确，读侧让"数据还没被修好之前"这段窗口里
 * 界面与回测不失真。它挂在 `view.dailyBars` 里，所有读 K 线的路径（因子、
 * 涨停判定、情绪、回测、K 线图）一次性都覆盖到，不需要每个消费方各自记得修。
 *
 * 幂等：已经正确的序列一字不改（新数组的元素保持同一对象引用，只有因子变了才复制）。
 *
 * @param bars 按日期升序
 */
export function repairAdjFactorSeries<T extends { adjFactor?: number | null }>(bars: readonly T[]): T[] {
  // 只复制需要改的元素：还有接着产物向上 return 的热路径（dailyBars 每天被调用几万次）
  let prev = 1;
  let out: T[] | null = null;
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    const f = typeof b.adjFactor === "number" && Number.isFinite(b.adjFactor) ? b.adjFactor : 1;
    // 台阶向前走：非 1 之后出现 1，只能是写坏了（真没除权的票整段都是 1，prev 也是 1）
    const want = f === 1 && prev !== 1 ? prev : f;
    if (want !== f) {
      if (out === null) out = bars.slice(0, i);
      out.push({ ...b, adjFactor: want } as T);
    } else if (out !== null) {
      out.push(b);
    }
    prev = want;
  }
  return out ?? (bars as T[]);
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
