/**
 * 涨停/跌停的日线代理重建（spec §8.1）。
 *
 * 这是因子层风险最高的一块：涨停家数、连板高度、赚钱效应全部建在它上面，
 * 判错一档，整条情绪链的回测结论就是假的。三个坑按顺序说明：
 *
 * 1. 单一阈值必错。主板 10% / 创业板科创板 20% / 北交所 30% / ST 5%，
 *    用 9.8% 一把切会把创业板的 10% 中阴线算成涨停。
 * 2. ST 状态随时间变化。用"今天是不是 ST"去判 2022 年的封板是错的 ——
 *    2022 年戴帽的票当年阈值是 5%，2023 摘帽后是 10%。所以必须查 isStHistory。
 * 3. 上市首日无涨跌幅限制。不排除的话新股首日涨 43% 会被算成一个涨停家数，
 *    情绪温度凭空升温。
 *
 * 还有一条判据容易被忽略：必须 close == high。收盘不在最高说明尾盘开板了，
 * "曾经涨停"和"封板收盘"对次日的意义完全不同。
 */
import type { DailyBar, PointInTimeView, SecurityRow } from "@/lib/contracts";
import { adjClose, barsUpTo, pctChange, round6 } from "@/lib/factors/util";

export interface LimitThresholds {
  主板: number; 创业板: number; 科创板: number; 北交所: number; ST: number;
}

/** 阈值留 0.2~0.3 个百分点余量：四舍五入到分的收盘价算出来的涨幅不会正好等于 10% */
export const DEFAULT_LIMIT_THRESHOLDS: LimitThresholds = {
  主板: 9.8, 创业板: 19.8, 科创板: 19.8, 北交所: 29.7, ST: 4.8,
};

/** 价格比较的容差。行情价精确到分，1e-6 足够区分"相等"与"差一分" */
const EPS = 1e-6;

/**
 * 某个代码在 date 这天是不是 ST。
 *
 * isStHistory 的区间按闭区间 [from, to] 理解，to = null 表示至今仍在风险警示。
 * 契约没写清开闭（见最终报告的契约缺口），这里选闭区间：宁可把摘帽当日
 * 仍按 5% 判，也不要把戴帽首日按 10% 判 —— 后者会把一个真涨停算成不涨停，
 * 是"漏"，前者只是"多算半天的严格"。
 */
export function wasSt(sec: SecurityRow, date: string): boolean {
  for (const seg of sec.isStHistory ?? []) {
    if (seg.from <= date && (seg.to === null || date <= seg.to)) return true;
  }
  return false;
}

/** listDate 未知时不能断言是首日 —— 宁可少排除一天，也不要把老票的涨停全废掉 */
export function isFirstListingDay(sec: SecurityRow, date: string): boolean {
  return sec.listDate !== null && sec.listDate === date;
}

/**
 * ST 优先于板块：戴帽期间不论哪个板，涨跌幅限制都按风险警示档走（spec §8.1 表）。
 *
 * ⚠️ 与现实有偏差：交易所规则里创业板/科创板的风险警示股仍是 20%，只有主板 ST 是 5%。
 * spec §8.1 的表没有按板区分 ST，这里先照 spec 实现（阈值全部可参数化，
 * 要改成按板区分只需换一份 LimitThresholds 并升 version）。
 * 影响范围：创业板/科创板的 ST 票会被按 4.8% 判涨停 —— 会**多算**涨停家数。
 * 这类票很少，但回测里它会系统性地把情绪温度抬高一点，已记入最终报告的 spec 矛盾清单。
 */
export function limitUpThreshold(
  sec: SecurityRow, date: string, t: LimitThresholds = DEFAULT_LIMIT_THRESHOLDS
): number {
  if (wasSt(sec, date)) return t.ST;
  return t[sec.board];
}

export interface LimitJudgement {
  limitUp: boolean;
  limitDown: boolean;
  /** 涨跌幅百分点。无前收时为 null，不是 0 —— 0 会被当成平盘 */
  pct: number | null;
  threshold: number;
  closeAtHigh: boolean;
  closeAtLow: boolean;
  reason: string;
}

function judge(
  sec: SecurityRow, bar: DailyBar, prev: DailyBar | null, t: LimitThresholds
): LimitJudgement {
  const threshold = limitUpThreshold(sec, bar.date, t);
  const closeAtHigh = Math.abs(bar.c - bar.h) <= EPS;
  const closeAtLow = Math.abs(bar.c - bar.l) <= EPS;
  const base = { limitUp: false, limitDown: false, pct: null, threshold, closeAtHigh, closeAtLow };

  if (isFirstListingDay(sec, bar.date)) {
    return { ...base, reason: "上市首日无涨跌幅限制，不计入涨跌停家数" };
  }
  if (prev === null) {
    return { ...base, reason: "无前收，无法判定" };
  }

  const pct = round6(pctChange(adjClose(prev), adjClose(bar)));
  return {
    limitUp: pct >= threshold - EPS && closeAtHigh,
    limitDown: pct <= -threshold + EPS && closeAtLow,
    pct, threshold, closeAtHigh, closeAtLow,
    reason: `pct=${pct} 阈值=±${threshold} 收盘==最高:${closeAtHigh} 收盘==最低:${closeAtLow}`,
  };
}

export function judgeBarLimitUp(
  sec: SecurityRow, bar: DailyBar, prev: DailyBar | null,
  t: LimitThresholds = DEFAULT_LIMIT_THRESHOLDS
): LimitJudgement {
  return judge(sec, bar, prev, t);
}

/** 跌停判定。防守档触发条件里有"跌停家数 > 30"，所以跌停也得能还原（spec §9.1） */
export function judgeBarLimitDown(
  sec: SecurityRow, bar: DailyBar, prev: DailyBar | null,
  t: LimitThresholds = DEFAULT_LIMIT_THRESHOLDS
): LimitJudgement {
  return judge(sec, bar, prev, t);
}

export interface ScanResult {
  codes: string[];
  /** 当日没有日线（停牌/未上市/缺口）或没有前收的票。不能当成"没涨停"，要单独计 */
  unknown: string[];
}

function scan(
  view: PointInTimeView, date: string, t: LimitThresholds, want: "up" | "down"
): ScanResult {
  const codes: string[] = [];
  const unknown: string[] = [];
  // 全市场近 6000 只，多拉一根都是成本。只有回放历史日期时才需要更深的窗口
  const pull = 8 + (date === view.asOf ? 0 : view.tradingDays(date, view.asOf).length);
  for (const sec of view.universe()) {
    const bars = barsUpTo(view, sec.code, date, 2, pull);
    const cur = bars.length > 0 ? bars[bars.length - 1] : null;
    if (cur === null || cur.date !== date) { unknown.push(sec.code); continue; }
    const prev = bars.length >= 2 ? bars[bars.length - 2] : null;
    const j = judge(sec, cur, prev, t);
    if (j.pct === null) { unknown.push(sec.code); continue; }
    if (want === "up" ? j.limitUp : j.limitDown) codes.push(sec.code);
  }
  return { codes, unknown };
}

export function limitUpCodes(
  view: PointInTimeView, date: string, t: LimitThresholds = DEFAULT_LIMIT_THRESHOLDS
): ScanResult {
  return scan(view, date, t, "up");
}

export function limitDownCodes(
  view: PointInTimeView, date: string, t: LimitThresholds = DEFAULT_LIMIT_THRESHOLDS
): ScanResult {
  return scan(view, date, t, "down");
}

/**
 * 连板数的日线代理：从 date 往前数连续封板的天数。
 *
 * 与 zt_pool.lbc 的差别在于"中间有一天开板但仍涨停收盘"这类情形，
 * 真快照按交易所口径给，代理只能按日线看，所以有真快照就别用它（见 env.ts）。
 */
export function proxyLbc(
  view: PointInTimeView, code: string, date: string,
  maxBack = 15, t: LimitThresholds = DEFAULT_LIMIT_THRESHOLDS
): number {
  const sec = view.security(code);
  if (sec === null) return 0;
  const bars = barsUpTo(view, code, date, maxBack + 1, maxBack + 60);
  if (bars.length === 0 || bars[bars.length - 1].date !== date) return 0;

  let n = 0;
  for (let i = bars.length - 1; i >= 1; i--) {
    if (!judge(sec, bars[i], bars[i - 1], t).limitUp) break;
    n++;
  }
  return n;
}
