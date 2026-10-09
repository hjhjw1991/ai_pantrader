import type { BacktestReport, EquityPoint } from "@/lib/contracts/backtest";
import { MIN_SAMPLE_DAYS, MIN_SAMPLE_TRADES, TRADING_DAYS_PER_YEAR } from "@/lib/backtest/metrics";
import { annualiseOf, dailyReturns, stdev } from "@/lib/backtest/series";
import type { BenchmarkSeries, BenchmarkStats } from "@/lib/backtest/benchmark";
import { shanghaiTs } from "@/lib/data/clock";

/**
 * 回测报告的自包含 HTML（tearsheet）。
 *
 * 三条硬约束，每一条都是为了让它**离得开这个应用**：
 *
 *   1. **零外部请求。** 没有 CDN、没有字体链接、没有 <script>。
 *      图表是手写的 <svg>，不是 lightweight-charts —— 后者要 JS 运行时，
 *      引它就必须在文件里塞一段 UMD（几百 KB）或者挂 CDN，两者都让文件不再是文件。
 *      双击打开、发邮件、打印成 PDF，都必须照常显示。
 *   2. **所有插值转义。** 报告里的字符串来自 YAML 配置，配错是常态不是异常。
 *      一个没转义的 `<` 就能把整份报告渲染成空白，而它事后会被当成"回测挂了"。
 *   3. **退化情形不抛。** 空净值、零交易、区间不足 —— 这些报告本来就存在，
 *      渲染器把它们画出来才是对的，抛异常等于让人看不到自己刚跑出来的东西。
 *
 * 涨红跌绿（A 股口径），与本系统其它界面一致。
 *
 * 这里**不新增任何 metrics 契约**。月度收益表、Sortino、波动率、最长回撤天数
 * 都是从净值推出来的派生量，只属于报告层：进契约意味着所有历史存档 JSON
 * 都要解释"为什么缺这几个字段"，而它们本来能从净值算回来。
 */

/**
 * 认形状。
 *
 * 存档里两种 JSON 结构不同（BacktestReport / SweepReport），**不能靠猜**，
 * 猜错就会渲染出一份半空的报告，而它看起来完全正常。
 * kind 在库中是有的，但这条路也可能被喂一份外部 JSON，所以两边都校验，
 * 共用这一份判据 —— 分开写两份，迟早有一份会漏掉新增的字段。
 */
export function checkBacktestShape(
  x: unknown
): { ok: true; report: BacktestReport } | { ok: false; missing: string[] } {
  if (typeof x !== "object" || x === null) return { ok: false, missing: ["整个报告"] };
  const r = x as Record<string, unknown>;
  const need: Array<[string, boolean]> = [
    ["strategyId", typeof r.strategyId === "string"],
    ["strategyVersion", typeof r.strategyVersion === "string"],
    ["resultHash", typeof r.resultHash === "string"],
    ["range", typeof r.range === "object" && r.range !== null],
    ["constraints", typeof r.constraints === "object" && r.constraints !== null],
    ["coverage", typeof r.coverage === "object" && r.coverage !== null],
    ["metrics", typeof r.metrics === "object" && r.metrics !== null],
    ["equity", Array.isArray(r.equity)],
  ];
  const missing = need.filter(([, v]) => !v).map(([k]) => k);
  return missing.length === 0 ? { ok: true, report: x as BacktestReport } : { ok: false, missing };
}

export interface TearsheetOptions {
  /** 生成时刻，缺省为上海挂钟。传值是为了让同一份报告能导出同一份文件 */
  generatedAt?: string;
  /** 页脚备注，例如从哪个存档导出的 */
  note?: string;
  /**
   * 基准对比。由调用方取好再喂进来，**不在本文件里查库**：
   * BacktestReport 是带 resultHash 的不可变快照，基准是外部取数，
   * 把取数塞进渲染层等于让同一份存档导出两个不同内容。
   */
  benchmark?: { series: BenchmarkSeries; stats: BenchmarkStats } | null;
  /** 取了基准但没取成时的原因。有它就在报告上写明"为什么没有基准" */
  benchmarkReason?: string;
}

/* ------------------------------- 小工具 ------------------------------- */

function esc(s: unknown): string {
  return String(s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/** 百分比，带符号。非有限值走 em dash —— 不编 0 */
function pct(x: number | null | undefined, digits = 2): string {
  if (x === null || x === undefined || !Number.isFinite(x)) return "—";
  return `${(x * 100).toFixed(digits)}%`;
}

function num(x: number | null | undefined, digits = 2): string {
  if (x === null || x === undefined || !Number.isFinite(x)) return "—";
  return x.toFixed(digits);
}

function money(x: number | null | undefined): string {
  if (x === null || x === undefined || !Number.isFinite(x)) return "—";
  return x.toLocaleString("zh-CN", { maximumFractionDigits: 0 });
}

/**
 * 页眉上的"生成于"取全库唯一的时钟出口（lib/data/clock）。
 *
 * 不在本文件里手写 `new Date(...)`：lib/data/clock 已经定了上海挂钟的口径，
 * 这里的重复实现一旦差一位——哪怕只是毫秒位数——同一份存档导出的两份文件
 * 就不再逐字节相同，而"同一份报告导出两个版本"是无法向人解释的。
 * 顺带也守住了 determinism 那条：渲染层的时钟只能从这一个出口来。
 */
function nowTs(): string {
  return shanghaiTs();
}

/* ---------------------------- 从净值派生的量 ---------------------------- */

interface Derived {
  /** 净值点数 = 回放到的交易日数 */
  days: number;
  totalReturn: number | null;
  volatility: number | null;
  sortino: number | null;
  /** 最长回撤持续交易日数：从高点到重回高点的最长跨度 */
  longestDdDays: number;
  bestDay: number | null;
  worstDay: number | null;
  /** 正收益交易日占比 */
  positiveDays: number | null;
  monthly: Array<{ year: string; cells: Array<number | null>; yearRet: number | null }>;
}

/**
 * 月度收益。每月取**该月最后一个净值点**，月收益 = 本月末 / 上月末 − 1。
 *
 * 第一个月给 null 而不是 0：它没有上月基准，记 0 会让它混进"持平"那一档，
 * 而表格本该显示"这里没有数据"。全库统一的一条：没有就显示为没有，不编 0。
 */
function monthlyReturns(equity: readonly EquityPoint[]): Derived["monthly"] {
  if (equity.length === 0) return [];
  const lastOfMonth = new Map<string, number>();
  for (const p of equity) lastOfMonth.set(p.date.slice(0, 7), p.equity);
  const keys = [...lastOfMonth.keys()].sort();
  if (keys.length === 0) return [];

  const retByMonth = new Map<string, number>();
  let prevClose: number | null = null;
  for (const k of keys) {
    const close = lastOfMonth.get(k)!;
    if (prevClose !== null && prevClose > 0) retByMonth.set(k, close / prevClose - 1);
    prevClose = close;
  }

  const years = [...new Set(keys.map(k => k.slice(0, 4)))].sort();

  /**
   * 全年 = 该年**最后一个有数据的月**的收盘 ÷ 上一年最后一个有数据的月的收盘 − 1。
   *
   * 不能写成"12 月那一格"：区间 9 月开始的话，那一格是 12 月单月收益，
   * 冒充全年会让跨年报告多出一个看起来有据可查、实际语义完全不同的数字；
   * 而到 9 月结束的区间又会因为找不到 12 月而变空，明明有九个月的数据。
   * 第一年没有上年基准，给 null —— 没有就显示为没有，不拿单月凑。
   */
  const closeOfYear = new Map<string, number>();
  for (const y of years) {
    const lastKey = keys.filter(k => k.startsWith(y)).pop();
    if (lastKey !== undefined) closeOfYear.set(y, lastOfMonth.get(lastKey)!);
  }

  return years.map((y, i) => {
    const cells: Array<number | null> = [];
    for (let m = 1; m <= 12; m++) {
      const k = `${y}-${String(m).padStart(2, "0")}`;
      cells.push(retByMonth.get(k) ?? null);
    }
    const prevY = i > 0 ? years[i - 1] : undefined;
    const prevClose = prevY === undefined ? null : closeOfYear.get(prevY) ?? null;
    const thisClose = closeOfYear.get(y) ?? null;
    const yearRet = prevClose !== null && prevClose > 0 && thisClose !== null
      ? thisClose / prevClose - 1 : null;
    return { year: y, cells, yearRet };
  });
}

function longestDrawdownDays(equity: readonly EquityPoint[]): number {
  let peak = -Infinity;
  let longest = 0;
  let start = 0;
  for (let i = 0; i < equity.length; i++) {
    const e = equity[i]!.equity;
    if (e > peak) {
      peak = e;
      longest = Math.max(longest, i - start);
      start = i;
    }
  }
  return Math.max(longest, equity.length - 1 - start);
}

function derive(equity: readonly EquityPoint[]): Derived {
  const rets = dailyReturns(equity);
  const sd = stdev(rets);
  const downside = stdev(rets.filter(r => r < 0));
  const mean = rets.length > 0 ? rets.reduce((a, b) => a + b, 0) / rets.length : null;
  const first = equity.length > 0 ? equity[0]!.equity : null;
  const last = equity.length > 0 ? equity[equity.length - 1]!.equity : null;
  return {
    days: equity.length,
    totalReturn: first !== null && last !== null && first > 0 ? last / first - 1 : null,
    volatility: sd === null ? null : sd * Math.sqrt(TRADING_DAYS_PER_YEAR),
    // 没有下行波动时 Sortino 无定义（分母为 0），记 null 而不是 Infinity
    sortino: mean === null || downside === null || downside === 0
      ? null : (mean / downside) * Math.sqrt(TRADING_DAYS_PER_YEAR),
    longestDdDays: longestDrawdownDays(equity),
    bestDay: rets.length > 0 ? Math.max(...rets) : null,
    worstDay: rets.length > 0 ? Math.min(...rets) : null,
    positiveDays: rets.length > 0 ? rets.filter(r => r > 0).length / rets.length : null,
    monthly: monthlyReturns(equity),
  };
}

/* -------------------------------- 图表 -------------------------------- */

const W = 900;
const H = 340;
const PAD_L = 66;
const PAD_R = 14;
const PAD_T = 16;
const BOTTOM = 316;

/**
 * 净值（上）与回撤（下）双联图。
 *
 * 回撤画在下面而不是叠在净值上：叠在一起时两条曲线共用一套刻度，
 * 净值的小波动会被压平，而回撤的深浅恰恰是这份报告最该看清的东西。
 */
function renderChart(equity: readonly EquityPoint[], bench?: readonly (number | null)[] | null): string {
  if (equity.length < 2) {
    return `<p class="empty">净值点只有 ${equity.length} 个，无法作图。</p>`;
  }
  const pw = W - PAD_L - PAD_R;
  const topArea = { top: PAD_T, h: 186 };
  const ddArea = { top: 232, h: 66 };

  /**
   * 量程必须把基准一起框进来。
   *
   * 只按策略净值定 y 轴的话，跑出量程的基准线会被 SVG 裁掉 ——
   * 而裁剪是**静默**的：图上看不到基准，读者只会以为"这条策略一直压着基准"，
   * 实际是基准涨得更高、被裁在框外。同图对比的前提是同量程。
   */
  const eqVals = equity.map(p => p.equity);
  const benchVals = (bench ?? []).filter((v): v is number => v !== null);
  let lo = Math.min(...eqVals, ...benchVals), hi = Math.max(...eqVals, ...benchVals);
  if (hi === lo) { hi = hi * 1.02 + 1e-9; lo = lo * 0.98 - 1e-9; } // 全平的曲线：造个量程，别除以 0
  const pad = (hi - lo) * 0.06;
  lo -= pad; hi += pad;

  let peak = -Infinity;
  const dd = equity.map(p => {
    peak = Math.max(peak, p.equity);
    return peak > 0 ? (p.equity - peak) / peak : 0;
  });
  const ddLo = Math.min(...dd, -0.0001);

  const x = (i: number) => PAD_L + (pw * i) / (equity.length - 1);
  const yEq = (v: number) => topArea.top + topArea.h * (1 - (v - lo) / (hi - lo));
  const yDd = (v: number) => ddArea.top + ddArea.h * (v / ddLo);

  const eqLine = equity.map((p, i) => `${x(i).toFixed(1)},${yEq(p.equity).toFixed(1)}`).join(" ");
  const ddEdge = dd.map((v, i) => `${x(i).toFixed(1)},${yDd(v).toFixed(1)}`);
  const ddPoly = `${PAD_L},${ddArea.top} ${ddEdge.join(" ")} ${x(equity.length - 1).toFixed(1)},${ddArea.top}`;

  const grid = [0, 0.25, 0.5, 0.75, 1].map(f => {
    const y = yEq(lo + (hi - lo) * f);
    return `<line class="grid" x1="${PAD_L}" y1="${y.toFixed(1)}" x2="${W - PAD_R}" y2="${y.toFixed(1)}"/>`
      + `<text class="ax" x="${PAD_L - 8}" y="${y.toFixed(1)}" text-anchor="end" dominant-baseline="central">${money(lo + (hi - lo) * f)}</text>`;
  }).join("");

  const ddGrid = [0, ddLo / 2, ddLo].map(v => {
    const y = yDd(v);
    return `<line class="grid" x1="${PAD_L}" y1="${y.toFixed(1)}" x2="${W - PAD_R}" y2="${y.toFixed(1)}"/>`
      + `<text class="ax" x="${PAD_L - 8}" y="${y.toFixed(1)}" text-anchor="end" dominant-baseline="central">${pct(v, 0)}</text>`;
  }).join("");

  // x 轴刻度最多 6 个，两端对齐，避免标签挤成一团
  const ticks = Math.min(6, equity.length);
  const xLabels: string[] = [];
  for (let t = 0; t < ticks; t++) {
    const i = Math.round((t * (equity.length - 1)) / (ticks - 1));
    const anchor = t === 0 ? "start" : t === ticks - 1 ? "end" : "middle";
    xLabels.push(`<text class="ax" x="${x(i).toFixed(1)}" y="${BOTTOM + 12}" text-anchor="${anchor}">${esc(equity[i]!.date.slice(0, 7))}</text>`);
  }

  const startLabel = equity[0]!.date;
  const endLabel = equity[equity.length - 1]!.date;
  const legend = benchVals.length > 1
    ? `<line class="bm" x1="${W - PAD_R - 118}" y1="${PAD_T - 8}" x2="${W - PAD_R - 98}" y2="${PAD_T - 8}"/>`
      + `<line class="eq" x1="${W - PAD_R - 92}" y1="${PAD_T - 8}" x2="${W - PAD_R - 72}" y2="${PAD_T - 8}"/>`
      + `<text class="cap" x="${W - PAD_R - 66}" y="${PAD_T - 5}">基准 / 策略</text>`
    : "";
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="净值曲线与回撤">`
    + `<rect class="ddband" x="${PAD_L}" y="${ddArea.top}" width="${pw}" height="${ddArea.h}"/>`
    + grid + ddGrid
    + `<polygon class="dd" points="${ddPoly}"/>`
    // 基准画在策略下面：两条线交叠时策略是主角，压在上方
    + benchSegments(bench ?? [], x, yEq)
    + `<polyline class="eq" points="${eqLine}"/>`
    + `<text class="cap" x="${PAD_L}" y="${PAD_T - 5}">净值 ${esc(startLabel)} → ${esc(endLabel)}</text>`
    + `<text class="cap ddcap" x="${W - PAD_R}" y="${PAD_T - 5}" text-anchor="end">回撤（下半区）</text>`
    + legend
    + xLabels.join("")
    + `</svg>`;
}

/**
 * 基准线。**遇到 null 要断成多段**，不能一条线连过去。
 *
 * 连过去等于用直线跨过"我们没数据"的那几天，而直线在图上和真实的走势
 * 长得一模一样 —— 这正是"看起来有基准"的最坏情形。
 */
function benchSegments(
  bench: readonly (number | null)[],
  x: (i: number) => number,
  y: (v: number) => number
): string {
  const segs: string[] = [];
  let cur: string[] = [];
  bench.forEach((v, i) => {
    if (v === null) {
      if (cur.length > 1) segs.push(cur.join(" "));
      cur = [];
      return;
    }
    cur.push(`${x(i).toFixed(1)},${y(v).toFixed(1)}`);
  });
  if (cur.length > 1) segs.push(cur.join(" "));
  return segs.map(s => `<polyline class="bm" points="${s}"/>`).join("");
}

/* ------------------------------- 片段渲染 ------------------------------- */

function cell(label: string, value: string, hint = "", tone = ""): string {
  return `<div class="cell${tone ? ` ${tone}` : ""}"><div class="k">${esc(label)}</div>`
    + `<div class="v">${value}</div>`
    + (hint ? `<div class="h">${esc(hint)}</div>` : "") + `</div>`;
}

/**
 * 基准对比区块。
 *
 * 没有基准时必须**写明没有**，而不是整块不出现 ——
 * 一块不出现的区域，读者会以为"这份报告本来就没有这一项"；
 * 写明"取了但区间内没有日线"才分得清是没做还是做不了。
 */
function benchmarkBlock(
  bm: { series: BenchmarkSeries; stats: BenchmarkStats } | null,
  reason: string | undefined,
): string {
  if (bm === null) {
    if (reason === undefined) return "";
    return `<h2>基准对比</h2><p class="empty">无基准：${esc(reason)}</p>`;
  }
  const s = bm.stats;
  const tone = (x: number | null) => (x === null ? "" : x >= 0 ? "up" : "down");
  const dropped = bm.series.availableDays - (bm.series.equity.length - bm.series.missingDays);

  const cells = [
    // cell() 自己会转义 hint，这里再 esc 一次会把 "&" 印成 "&amp;amp;"
    cell("基准区间收益", pct(s.benchTotal), `${bm.series.name} 买入持有`, tone(s.benchTotal)),
    cell("基准年化", pct(s.benchAnnual), "同一套折算口径", tone(s.benchAnnual)),
    cell("基准最大回撤", pct(s.benchMaxDD), "", "down"),
    cell("超额（区间）", pct(s.excessTotal), "策略 − 基准", tone(s.excessTotal)),
    cell("年化超额", pct(s.excessAnnual), "两端年化之差", tone(s.excessAnnual)),
    cell("Beta", num(s.beta), "cov(策略,基准)/var(基准)"),
    cell("年化 Alpha", pct(s.alphaAnnual), "策略年化 − β×基准年化", tone(s.alphaAnnual)),
    cell("相关系数", num(s.correlation), "日收益"),
    cell("跟踪误差", pct(s.trackingError, 1), "日超额波动年化"),
    cell("信息比率", num(s.infoRatio), "年化超额 / 跟踪误差", tone(s.infoRatio)),
    cell("跑赢基准日占比", pct(s.outperformingDays, 1), `${s.paired} 个有效配对日`),
  ].join("\n  ");

  const caveats: string[] = [];
  if (bm.series.alignedFrom !== undefined) {
    caveats.push(`策略首日没有基准数据，基准从第一个共同交易日 ${bm.series.alignedFrom} 起算、归一到策略当天的净值；对比统计同样从这天算起`);
  }
  if (dropped > 0) {
    caveats.push(`区间内基准自己有 ${bm.series.availableDays} 个交易日，其中 ${dropped} 天是策略的数据缺口日，已一并丢弃`);
  }
  if (bm.series.missingDays > 0) {
    caveats.push(`有 ${bm.series.missingDays} 个策略交易日缺基准数据，这些天跳过配对、未插值，线在图上断开`);
  }
  caveats.push("基准是买入持有，不含任何费用；策略一侧含滑点与费率");

  return `<h2>基准对比 · ${esc(bm.series.name)} <span style="color:var(--ink3);font-weight:400">${esc(bm.series.code)}</span></h2>
<div class="grid">
  ${cells}
</div>
<p class="note">${caveats.map(esc).join("；")}。</p>`;
}

function monthlyTable(monthly: Derived["monthly"]): string {
  if (monthly.length === 0) return `<p class="empty">区间不足一个月，无月度收益。</p>`;
  const head = ["年", ...Array.from({ length: 12 }, (_, i) => `${i + 1}月`), "全年"];
  const rows = monthly.map(r => {
    const tds = r.cells.map(v => {
      if (v === null) return `<td class="na">·</td>`;
      return `<td class="${v > 0 ? "up" : v < 0 ? "down" : "flat"}">${pct(v, 1)}</td>`;
    }).join("");
    const yr = r.yearRet === null
      ? `<td class="na">·</td>`
      : `<td class="${r.yearRet > 0 ? "up" : r.yearRet < 0 ? "down" : "flat"} yr">${pct(r.yearRet, 1)}</td>`;
    return `<tr><th>${esc(r.year)}</th>${tds}${yr}</tr>`;
  }).join("");
  return `<table><thead><tr>${head.map(h => `<th>${h}</th>`).join("")}</tr></thead>`
    + `<tbody>${rows}</tbody></table>`
    + `<p class="note">月收益 = 本月末净值 ÷ 上月末净值 − 1；全年 = 该年最后一个有数据的月 ÷ 上一年`
    + `最后一个有数据的月 − 1。首年没有上年基准，记「·」而不是拿单月凑。</p>`;
}

/* --------------------------------- 主体 --------------------------------- */

export function renderTearsheet(report: BacktestReport, o: TearsheetOptions = {}): string {
  const m = report.metrics;
  const d = derive(report.equity);
  const cov = report.coverage;
  const low = cov.lowConfidenceFactors ?? [];
  const healthBad = cov.gapDays > 0 || low.length > 0;
  const generatedAt = o.generatedAt ?? nowTs();
  const bm = o.benchmark ?? null;
  const benchSeries = bm === null ? null : bm.series.equity;
  const benchBlock = benchmarkBlock(bm, o.benchmarkReason);

  const constraints = [
    report.constraints.t1 ? "T+1" : "",
    report.constraints.limitUpUnbuyable ? "涨停买不进" : "",
    report.constraints.limitDownUnsellable ? "跌停卖不出" : "",
    report.constraints.suspensionBlocks ? "停牌不成交" : "",
  ].filter(Boolean).join(" · ");

  /**
   * Calmar 被判退化时记 0，而 0 和"真的算出来是 0"在页面上长得一模一样。
   * 只看数字会把"不够格"读成"很差"，所以这里必须写明是哪一种 ——
   * 而且判据**必须引用 metrics.ts 的那两个常量**：这里自己写字面量的话，
   * 阈值一改，报告就开始对着旧口径解释一份新的结果。
   */
  const calmarNote = m.maxDrawdown > 0 && m.trades >= MIN_SAMPLE_TRADES && d.days >= MIN_SAMPLE_DAYS
    ? "年化 / 最大回撤"
    : `判据：回撤>0、笔数≥${MIN_SAMPLE_TRADES}、交易日≥${MIN_SAMPLE_DAYS}，不满足则计入退化`;

  return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>回测报告 ${esc(report.strategyId)} ${esc(report.range.from)}→${esc(report.range.to)}</title>
<style>
:root{--line:#e2e0d9;--ink:#20242b;--ink2:#5f6b7a;--ink3:#8b949e;--up:#c0392b;--down:#1e8449;--sunk:#f7f6f2}
*{box-sizing:border-box}
body{margin:0;padding:32px 28px 48px;background:var(--sunk);color:var(--ink);
 font:14px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif}
.wrap{max-width:1000px;margin:0 auto;background:#fff;border:1px solid var(--line);border-radius:10px;padding:28px 30px 34px}
h1{font-size:19px;font-weight:600;margin:0 0 4px}
.sub{color:var(--ink2);font-size:13px;margin-bottom:20px}
h2{font-size:14px;font-weight:600;margin:26px 0 10px;padding-bottom:6px;border-bottom:1px solid var(--line)}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:1px;background:var(--line);border:1px solid var(--line);border-radius:8px;overflow:hidden}
.cell{background:#fff;padding:11px 13px}
.cell.warn{background:#fdf6ec}
.k{color:var(--ink2);font-size:12px}
.v{font-size:19px;font-weight:600;margin-top:3px;font-variant-numeric:tabular-nums}
.h{color:var(--ink3);font-size:11px;margin-top:2px}
.up{color:var(--up)}.down{color:var(--down)}
.banner{border:1px solid var(--line);border-radius:8px;padding:12px 14px;margin-bottom:18px}
.banner.bad{border-color:#e8b96a;background:#fdf8ef}
.empty{color:var(--ink3);font-size:13px;padding:10px 0}
.note{color:var(--ink3);font-size:11px;margin:8px 0 0}
figure{margin:12px 0 0}
figure svg{display:block}
.grid{stroke:#eceae4;stroke-width:1}
text.ax{font-size:11px;fill:var(--ink3);font-variant-numeric:tabular-nums}
text.cap{font-size:11px;fill:var(--ink2)}
text.ddcap{fill:var(--up)}
.eq{fill:none;stroke:#2b6cb0;stroke-width:1.6}
.bm{fill:none;stroke:#8b949e;stroke-width:1.3;stroke-dasharray:5 3}
.dd{fill:rgba(192,57,43,.16);stroke:#c0392b;stroke-width:.8}
.ddband{fill:#fbfaf7}
table{border-collapse:collapse;width:100%;font-size:12px;font-variant-numeric:tabular-nums}
th,td{padding:5px 6px;text-align:right;border-bottom:1px solid #f0eee8}
thead th{color:var(--ink2);font-weight:600;text-align:right;border-bottom:1px solid var(--line)}
tbody th{text-align:left;font-weight:600;color:var(--ink)}
td.na{color:#c9c7c0}
td.yr{font-weight:600}
details{margin-top:10px}
summary{cursor:pointer;color:var(--ink2);font-size:12px;padding:5px 0}
pre{background:var(--sunk);border:1px solid var(--line);border-radius:6px;padding:12px;overflow:auto;font-size:11px;line-height:1.5}
footer{margin-top:26px;padding-top:12px;border-top:1px solid var(--line);color:var(--ink3);font-size:11px}
@media print{body{background:#fff;padding:0}.wrap{border:none;border-radius:0;padding:0}}
</style></head>
<body><div class="wrap">

<h1>回测报告 · ${esc(report.strategyId)} <span style="color:var(--ink3);font-weight:400">v${esc(report.strategyVersion)}</span></h1>
<div class="sub">区间 ${esc(report.range.from)} → ${esc(report.range.to)} · ${d.days} 个净值点 · 生成于 ${esc(generatedAt)}</div>

<div class="banner${healthBad ? " bad" : ""}">
  <div class="grid">
    ${cell("数据覆盖率", pct(cov.coverage, 1), "有效交易日 / 应有交易日")}
    ${cell("缺口天数", String(cov.gapDays), cov.gapDays > 0 ? "缺的日已跳过，未插值" : "无缺口", cov.gapDays > 0 ? "warn" : "")}
    ${cell("有效区间", `${cov.effectiveRange.from} → ${cov.effectiveRange.to}`, "复权断层可能让它短于请求区间")}
    ${cell("低置信因子", String(low.length), low.length > 0 ? low.map(f => `${f.name} ρ=${f.rho.toFixed(2)}`).join("，") : "无", low.length > 0 ? "warn" : "")}
  </div>
  ${low.length > 0
    ? `<p style="margin:10px 0 0;color:var(--up);font-size:12px">ρ&lt;0.8 的代理因子参与了决策：ρ 越低，下面的数字越不可当结论。</p>`
    : ""}
</div>

<h2>核心指标</h2>
<div class="grid">
  ${cell("Calmar", num(m.calmar), calmarNote)}
  ${cell("年化收益", pct(m.annualReturn), "", m.annualReturn >= 0 ? "up" : "down")}
  ${cell("最大回撤", pct(m.maxDrawdown), "", "down")}
  ${cell("Sharpe", num(m.sharpe))}
  ${cell("胜率", pct(m.winRate, 1))}
  ${cell("盈亏比", num(m.profitFactor))}
  ${cell("交易笔数", String(m.trades), "平仓笔数")}
  ${cell("平均持仓", `${num(m.avgHoldDays, 1)} 天`)}
  ${cell("触发率", pct(m.triggerRate, 1), m.buyDecisions > 0 ? `${m.buyFilled} / ${m.buyDecisions} 笔买到` : "无买入决策")}
</div>

<h2>净值曲线</h2>
<figure>${renderChart(report.equity, benchSeries)}</figure>
${benchBlock}

<h2>派生指标</h2>
<div class="grid">
  ${cell("区间总收益", pct(d.totalReturn), "净值首尾比", (d.totalReturn ?? 0) >= 0 ? "up" : "down")}
  ${cell("年化波动率", pct(d.volatility, 1), "日收益样本标准差折算")}
  ${cell("Sortino", num(d.sortino), "只除下行波动")}
  ${cell("最长回撤持续", `${d.longestDdDays} 个交易日`, "高点到重回高点")}
  ${cell("最好单日", pct(d.bestDay, 2), "", "up")}
  ${cell("最差单日", pct(d.worstDay, 2), "", "down")}
  ${cell("上涨日占比", pct(d.positiveDays, 1))}
  ${cell("期末净值", money(report.equity.length > 0 ? report.equity[report.equity.length - 1]!.equity : null))}
</div>

<h2>月度收益</h2>
${monthlyTable(d.monthly)}

${report.split ? `<h2>样本内 / 样本外</h2>
<div class="grid">
  ${cell("样本内 Calmar", num(report.split.inSample.calmar))}
  ${cell("样本内年化", pct(report.split.inSample.annualReturn))}
  ${cell("样本外 Calmar", num(report.split.outOfSample.calmar))}
  ${cell("样本外年化", pct(report.split.outOfSample.annualReturn))}
</div>
<p style="color:var(--ink3);font-size:11px;margin:8px 0 0">样本外不过就是不过，不许回头调样本内。</p>` : ""}

<h2>约束与溯源</h2>
<div class="grid">
  ${cell("A股约束", constraints || "全部关闭", "关掉任意一条都会让结果虚高")}
  ${cell("滑点", pct(report.constraints.slippage, 2), "单边")}
  ${cell("费率", pct(report.constraints.feeRate, 3), "单边")}
  ${cell("最低费用", money(report.constraints.minFee))}
</div>
<details><summary>结果哈希与当时那份配置</summary>
<pre>resultHash ${esc(report.resultHash)}
同份输入两次运行必须一致。

config
${esc(JSON.stringify(report.config, null, 2))}</pre>
</details>

<footer>
  回测 ≠ 实盘：封板买不进、滑点、情绪不可完全量化。本报告的封面四项（覆盖率 / 缺口 / 低置信因子 / 有效区间）
  决定了后面这些数字能不能当结论。${o.note ? esc(o.note) : ""}
</footer>

</div></body></html>`;
}
