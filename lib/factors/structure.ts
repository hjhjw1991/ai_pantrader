/**
 * 技术结构：MACD（日 / 周）、ATR、分形拐点、结构位、M 顶 W 底。
 *
 * 口径对齐通达信：EMA 首值取 X[0]、MACD 柱 = 2 × (DIF − DEA)、ATR = MA(TR, N)。
 *
 * **价格口径**：指标一律算在后复权价上（除权那天原始价会凭空跳空，
 * 拿原始价算 MACD 每个分红季都会造出假死叉）。但给人看、给定价用的数字要换回原始价：
 * 后复权价 ÷ 当日复权因子 = 以今天为基准的前复权价，也就是券商 App 默认显示的那个。
 * 这个换算是常数倍，所以金叉死叉的位置、拐点的位置都不受影响，只有数值的尺度变。
 *
 * 拐点只取**已确认**的：左右各 k 根。最后 k 根永远不是拐点 —— 右边还没走出来，
 * 判了就是在用明天的 K 线。代价是结构位与形态识别天然滞后 k 根，这是正确的滞后。
 */
import type { DailyBar, FactorResult, FactorSpec, PointInTimeView } from "@/lib/contracts";
import { mean, pnum, requireCode, round6, evalDate } from "@/lib/factors/util";

const V = "1.0.0";

/* -------------------------------- 纯函数 -------------------------------- */

/** 通达信 EMA：Y = (2X + (N−1)Y') / (N+1)，首值取 X[0] */
export function ema(xs: number[], n: number): number[] {
  const out: number[] = [];
  const a = 2 / (n + 1);
  for (let i = 0; i < xs.length; i++) out.push(i === 0 ? xs[0] : a * xs[i] + (1 - a) * out[i - 1]);
  return out;
}

export interface Macd { dif: number[]; dea: number[]; hist: number[] }

export function macd(closes: number[], fast = 12, slow = 26, sig = 9): Macd {
  const f = ema(closes, fast), s = ema(closes, slow);
  const dif = closes.map((_, i) => f[i] - s[i]);
  const dea = ema(dif, sig);
  return { dif, dea, hist: dif.map((d, i) => 2 * (d - dea[i])) };
}

export interface CrossEvent { i: number; kind: "金叉" | "死叉" }

/** 前一根 (a−b) ≤ 0 且当前 > 0 为金叉；前一根 ≥ 0 且当前 < 0 为死叉 */
export function crosses(a: number[], b: number[]): CrossEvent[] {
  const out: CrossEvent[] = [];
  for (let i = 1; i < a.length; i++) {
    const p = a[i - 1] - b[i - 1], c = a[i] - b[i];
    if (p <= 0 && c > 0) out.push({ i, kind: "金叉" });
    else if (p >= 0 && c < 0) out.push({ i, kind: "死叉" });
  }
  return out;
}

/** ATR = 最近 n 根 TR 的简单均值。首根没有昨收，TR 取高−低。样本不足 n 根返回 null */
export function atr(bars: Pick<DailyBar, "h" | "l" | "c">[], n: number): number | null {
  if (bars.length < n) return null;
  const tr = bars.map((b, i) => i === 0 ? b.h - b.l
    : Math.max(b.h - b.l, Math.abs(b.h - bars[i - 1].c), Math.abs(b.l - bars[i - 1].c)));
  return mean(tr.slice(-n));
}

export interface Pivot { i: number; kind: "高" | "低"; price: number }

/**
 * 分形拐点：高点比左边 k 根的高都**严格**高、且不低于右边 k 根；低点对称。
 * 左严右宽是为了平台顶只认第一根 —— 两边都用 ≥ 会让一段平顶每根都算拐点。
 */
export function pivots(bars: Pick<DailyBar, "h" | "l">[], k: number): Pivot[] {
  const out: Pivot[] = [];
  for (let i = k; i <= bars.length - 1 - k; i++) {
    let hi = true, lo = true;
    for (let j = 1; j <= k; j++) {
      if (!(bars[i].h > bars[i - j].h && bars[i].h >= bars[i + j].h)) hi = false;
      if (!(bars[i].l < bars[i - j].l && bars[i].l <= bars[i + j].l)) lo = false;
    }
    if (hi) out.push({ i, kind: "高", price: bars[i].h });
    if (lo) out.push({ i, kind: "低", price: bars[i].l });
  }
  return out;
}

/**
 * 现价上方最近的拐点高（阻力）与下方最近的拐点低（支撑）。没有就是 null，不编。
 *
 * minDist：离现价不到这个距离的拐点跳过。k 根分形会认出很多贴着现价的小毛刺，
 * 拿它们当目标和止损，盈亏比就成了两个噪声的比值。实测不过滤时平安银行
 * 阻力 11.90 / 支撑 11.65 / 现价 11.71 —— 两边都在一天的正常波动之内。
 */
export function structureLevels(
  pv: Pivot[], px: number, minDist = 0
): { resistance: number | null; support: number | null } {
  let resistance: number | null = null, support: number | null = null;
  for (const p of pv) {
    if (p.kind === "高" && p.price > px + minDist && (resistance === null || p.price < resistance)) resistance = p.price;
    if (p.kind === "低" && p.price < px - minDist && (support === null || p.price > support)) support = p.price;
  }
  return { resistance, support };
}

export interface DoublePattern {
  kind: "M顶" | "W底";
  state: "形成中" | "确认";
  neckline: number;
  breakDate: string | null;
  points: Array<{ role: string; date: string; price: number }>;
}

export interface DoubleOpts {
  k: number;
  /** 两个顶（底）的价差上限，相对第一个 */
  tol?: number;
  /** 两个顶（底）之间至少隔几根 */
  minGap?: number;
  maxGap?: number;
  /** 颈线离两顶（底）至少多远，否则只是横盘里的两个小毛刺 */
  minDepth?: number;
  /** 破颈线之后多少根以内才报"确认"。更早的破位是旧结构，不说明现在 */
  confirmAge?: number;
  /** 第二顶（底）之后多少根以内还没破颈线才报"形成中"。拖太久形态就散了 */
  formAge?: number;
}

/**
 * M 顶 / W 底：最近两个同向拐点价差在 tol 以内、间隔在 [minGap, maxGap]、
 * 中间回撤（反弹）出一条颈线。第二个拐点之后：
 *   - 收盘跌破（上破）颈线 → 确认，记下那一天
 *   - 收盘越过两顶（底）的极值再加 tol → 形态作废（那是突破，不是双顶）
 *   - 否则 → 形成中
 * 同时存在时取第二个拐点更近的那个：最近的结构说明现在。
 */
export function doublePattern(bars: DailyBar[], o: DoubleOpts): DoublePattern | null {
  const tol = o.tol ?? 0.03, minGap = o.minGap ?? 5, maxGap = o.maxGap ?? 60, depth = o.minDepth ?? 0.03;
  const confirmAge = o.confirmAge ?? 10, formAge = o.formAge ?? 20;
  const lastI = bars.length - 1;
  const pv = pivots(bars, o.k);
  const cand: Array<{ at: number; p: DoublePattern }> = [];

  for (const top of [true, false]) {
    const same = pv.filter(p => p.kind === (top ? "高" : "低"));
    if (same.length < 2) continue;
    const a = same[same.length - 2], b = same[same.length - 1];
    const gap = b.i - a.i;
    if (gap < minGap || gap > maxGap) continue;
    if (Math.abs(b.price - a.price) / a.price > tol) continue;

    let ni = a.i + 1;
    for (let i = a.i + 1; i < b.i; i++) {
      if (top ? bars[i].l < bars[ni].l : bars[i].h > bars[ni].h) ni = i;
    }
    const neck = top ? bars[ni].l : bars[ni].h;
    const ext = top ? Math.min(a.price, b.price) : Math.max(a.price, b.price);
    if ((top ? (ext - neck) / ext : (neck - ext) / ext) < depth) continue;

    const far = top ? Math.max(a.price, b.price) * (1 + tol) : Math.min(a.price, b.price) * (1 - tol);
    let breakAt: number | null = null, dead = false;
    for (let i = b.i + 1; i < bars.length; i++) {
      const c = bars[i].c;
      if (top ? c > far : c < far) { dead = true; break; }
      if (top ? c < neck : c > neck) { breakAt = i; break; }
    }
    if (dead) continue;
    if (breakAt !== null ? lastI - breakAt > confirmAge : lastI - b.i > formAge) continue;
    const names = top ? ["第一顶", "颈线", "第二顶"] : ["第一底", "颈线", "第二底"];
    cand.push({
      at: b.i,
      p: {
        kind: top ? "M顶" : "W底",
        state: breakAt === null ? "形成中" : "确认",
        neckline: neck,
        breakDate: breakAt === null ? null : bars[breakAt].date,
        points: [
          { role: names[0], date: bars[a.i].date, price: a.price },
          { role: names[1], date: bars[ni].date, price: neck },
          { role: names[2], date: bars[b.i].date, price: b.price },
        ],
      },
    });
  }
  if (cand.length === 0) return null;
  cand.sort((x, y) => y.at - x.at);
  return cand[0].p;
}

/* -------------------------------- 因子 -------------------------------- */

/** 截至评估日的后复权日线。回放时评估日早于 asOf，要多拉一段再截 */
function adjUpTo(view: PointInTimeView, code: string, date: string, n: number): DailyBar[] {
  const behind = date === view.asOf.slice(0, 10) ? 0 : view.tradingDays(date, view.asOf).length;
  return view.adjBars(code, n + behind).filter(b => b.date <= date).slice(-n);
}

const r6 = (x: number | null) => (x === null ? null : round6(x));

/** 最后一根 K 线离评估日超过这么多个交易日，就不拿它当"现在" */
const MAX_STALE = 5;

/**
 * 最后一根日线落后评估日几个交易日。
 *
 * 必须查：实测全市场扫描里冒出过 1997 年、2005 年的"近 3 日金叉" —— 那是停牌多年、
 * 退市却没标 delist_date 的票，最后一根 K 线停在那年，因子就把那一根当成了今天。
 * 短暂停牌（几天）照常算，滞后写进 inputs；超过 MAX_STALE 一律置信 0。
 */
function staleness(view: PointInTimeView, lastDate: string, date: string): number {
  if (lastDate >= date) return 0;
  return Math.max(0, view.tradingDays(lastDate, date).length - 1);
}

function staleResult<T>(name: string, value: T, code: string, date: string, lastDate: string, lag: number): FactorResult<T> {
  return { name, version: V, value, label: "无近期数据", provenance: "real", confidence: 0,
    inputs: { 代码: code, 日期: date, 最后K线: lastDate, 滞后交易日: lag } };
}

function macdFactor(name: string, which: "D" | "W"): FactorSpec<number | null> {
  return {
    name, version: V, group: "tech",
    defaults: { 快线: 12, 慢线: 26, 信号线: 9, 交叉窗口: 3, 最少根数: which === "D" ? 60 : 35 },
    fn: ctx => {
      const code = requireCode(ctx.params, name);
      const date = evalDate(ctx.view, ctx.params).slice(0, 10);
      const daily = adjUpTo(ctx.view, code, date, which === "D" ? 250 : 5);
      const bars = which === "D" ? daily
        : ctx.view.periodBars(code, "W", 150).filter(b => b.date <= date);
      const need = pnum(ctx.params, "最少根数", which === "D" ? 60 : 35);
      const scale = daily.length > 0 ? daily[daily.length - 1].adjFactor : 1;
      const base = { 代码: code, 日期: date, 根数: bars.length, 周期: which === "D" ? "日线" : "周线（已完成的周）" };
      // 周线有、日线却为空（数据源错位）也按样本不足处理：下面的停牌判断要读最后一根日线
      if (bars.length < need || daily.length === 0 || !(scale > 0)) {
        return { name, version: V, value: null, label: "样本不足", provenance: "real", confidence: 0, inputs: base };
      }
      const lag = staleness(ctx.view, daily[daily.length - 1].date, date);
      if (lag > MAX_STALE) return staleResult(name, null, code, date, daily[daily.length - 1].date, lag);
      const m = macd(bars.map(b => b.c), pnum(ctx.params, "快线", 12), pnum(ctx.params, "慢线", 26), pnum(ctx.params, "信号线", 9));
      const last = bars.length - 1;
      const ev = crosses(m.dif, m.dea);
      const lastCross = ev.length > 0 ? ev[ev.length - 1] : null;
      const ago = lastCross === null ? null : last - lastCross.i;
      const win = pnum(ctx.params, "交叉窗口", 3);
      const label = lastCross !== null && ago !== null && ago < win ? lastCross.kind
        : m.dif[last] > m.dea[last] ? "多头" : "空头";
      const dif = m.dif[last] / scale, dea = m.dea[last] / scale;
      return {
        name, version: V, value: round6(m.hist[last] / scale), label, provenance: "real", confidence: 1,
        inputs: {
          ...base, DIF: round6(dif), DEA: round6(dea), 零轴上方: dif > 0, 滞后交易日: lag,
          最近交叉: lastCross === null ? null : { 类型: lastCross.kind, 日期: bars[lastCross.i].date, 距今: ago },
        },
      };
    },
  };
}

const ATR: FactorSpec<number | null> = {
  name: "ATR", version: V, group: "tech",
  defaults: { 周期: 14 },
  fn: ctx => {
    const code = requireCode(ctx.params, "ATR");
    const date = evalDate(ctx.view, ctx.params).slice(0, 10);
    const n = Math.max(1, Math.floor(pnum(ctx.params, "周期", 14)));
    const bars = adjUpTo(ctx.view, code, date, n + 1);
    const a = atr(bars, n);
    const last = bars.length > 0 ? bars[bars.length - 1] : null;
    if (a === null || last === null || !(last.c > 0)) {
      return { name: "ATR", version: V, value: null, label: "样本不足", provenance: "real", confidence: 0,
        inputs: { 代码: code, 日期: date, 根数: bars.length } };
    }
    const lag = staleness(ctx.view, last.date, date);
    if (lag > MAX_STALE) return staleResult("ATR", null, code, date, last.date, lag);
    const ratio = a / last.c;
    return {
      name: "ATR", version: V, value: round6(ratio),
      label: `日均波动 ${(ratio * 100).toFixed(1)}%`,
      provenance: "real", confidence: 1,
      // ATR 换回原始价口径：止损距离要挂进券商，必须是市场上的真实价位尺度
      inputs: { 代码: code, 日期: date, 周期: n, ATR: round6(a / last.adjFactor), 收盘: round6(last.c / last.adjFactor) },
    };
  },
};

/**
 * 结构位：现价上方最近的拐点高 = 阻力（目标），下方最近的拐点低 = 支撑（止损参照）。
 * 值为结构盈亏比 (阻力 − 现价) / (现价 − 支撑)。上方无结构位时值为 null ——
 * 创新高的票目标位不知道，编一个就是给盈亏比造假。
 */
const 结构位: FactorSpec<number | null> = {
  name: "结构位", version: V, group: "tech",
  defaults: { 回看根数: 120, 拐点宽度: 3, 最小距离ATR: 0.5, ATR周期: 14 },
  fn: ctx => {
    const code = requireCode(ctx.params, "结构位");
    const date = evalDate(ctx.view, ctx.params).slice(0, 10);
    const bars = adjUpTo(ctx.view, code, date, Math.max(10, Math.floor(pnum(ctx.params, "回看根数", 120))));
    const k = Math.max(1, Math.floor(pnum(ctx.params, "拐点宽度", 3)));
    const last = bars.length > 0 ? bars[bars.length - 1] : null;
    if (last === null || bars.length < 2 * k + 3 || !(last.adjFactor > 0)) {
      return { name: "结构位", version: V, value: null, label: "样本不足", provenance: "real", confidence: 0,
        inputs: { 代码: code, 日期: date, 根数: bars.length } };
    }
    const lag = staleness(ctx.view, last.date, date);
    if (lag > MAX_STALE) return staleResult("结构位", null, code, date, last.date, lag);
    const f = last.adjFactor;
    const px = last.c / f;
    const a = atr(bars, Math.max(1, Math.floor(pnum(ctx.params, "ATR周期", 14))));
    const minDist = (a ?? 0) * pnum(ctx.params, "最小距离ATR", 0.5);
    const lv = structureLevels(pivots(bars, k), last.c, minDist);
    const res = lv.resistance === null ? null : lv.resistance / f;
    const sup = lv.support === null ? null : lv.support / f;
    const rr = res !== null && sup !== null && px > sup ? (res - px) / (px - sup) : null;
    const label = res === null ? "上方无结构位" : sup === null ? "下方无结构位" : `盈亏比 ${rr!.toFixed(2)}`;
    return {
      name: "结构位", version: V, value: r6(rr), label, provenance: "real", confidence: 1,
      inputs: {
        代码: code, 日期: date, 现价: round6(px), 阻力: r6(res), 支撑: r6(sup),
        距阻力: res === null ? null : round6(res / px - 1), 距支撑: sup === null ? null : round6(1 - sup / px),
        拐点宽度: k,
      },
    };
  },
};

/**
 * M 顶 / W 底。值：M 顶确认 −1、M 顶形成中 −0.5、W 底形成中 +0.5、W 底确认 +1、无 0。
 * 形态点（两顶一颈线的日期与价格，原始价口径）放进 inputs，给 K 线图标注用。
 */
const M顶W底: FactorSpec<number> = {
  name: "M顶W底", version: V, group: "tech",
  defaults: {
    // 间隔 ≥10 根、颈线深 ≥6%：放宽到 5 根 / 3% 时实测全市场过半的票"有形态"，
    // 震荡市里任意两个相近的小高点都能凑出一个 M 顶，那种形态不携带信息
    回看根数: 120, 拐点宽度: 3, 价差容忍: 0.03, 最小间隔: 10, 最大间隔: 60, 最小深度: 0.06,
    确认时效: 10, 形成时效: 20,
  },
  fn: ctx => {
    const code = requireCode(ctx.params, "M顶W底");
    const date = evalDate(ctx.view, ctx.params).slice(0, 10);
    const bars = adjUpTo(ctx.view, code, date, Math.max(10, Math.floor(pnum(ctx.params, "回看根数", 120))));
    const k = Math.max(1, Math.floor(pnum(ctx.params, "拐点宽度", 3)));
    const last = bars.length > 0 ? bars[bars.length - 1] : null;
    if (last === null || bars.length < 2 * k + 8) {
      return { name: "M顶W底", version: V, value: 0, label: "样本不足", provenance: "real", confidence: 0,
        inputs: { 代码: code, 日期: date, 根数: bars.length } };
    }
    const lag = staleness(ctx.view, last.date, date);
    if (lag > MAX_STALE) return staleResult("M顶W底", 0, code, date, last.date, lag);
    const p = doublePattern(bars, {
      k, tol: pnum(ctx.params, "价差容忍", 0.03), minGap: pnum(ctx.params, "最小间隔", 10),
      maxGap: pnum(ctx.params, "最大间隔", 60), minDepth: pnum(ctx.params, "最小深度", 0.06),
      confirmAge: pnum(ctx.params, "确认时效", 10), formAge: pnum(ctx.params, "形成时效", 20),
    });
    const base = { 代码: code, 日期: date, 拐点宽度: k };
    if (p === null) {
      return { name: "M顶W底", version: V, value: 0, label: "无", provenance: "real", confidence: 1, inputs: base };
    }
    const f = last.adjFactor;
    const sign = p.kind === "M顶" ? -1 : 1;
    const out: FactorResult<number> = {
      name: "M顶W底", version: V, value: sign * (p.state === "确认" ? 1 : 0.5),
      label: `${p.kind}${p.state}`, provenance: "real", confidence: 1,
      inputs: {
        ...base, 形态: p.kind, 状态: p.state, 颈线: round6(p.neckline / f), 破颈日: p.breakDate,
        形态点: p.points.map(x => ({ 角色: x.role, 日期: x.date, 价格: round6(x.price / f) })),
      },
    };
    return out;
  },
};

export const STRUCTURE_FACTORS: FactorSpec<any>[] = [
  macdFactor("日线MACD", "D"), macdFactor("周线MACD", "W"), ATR, 结构位, M顶W底,
];
