/**
 * 技术组因子（spec §8）：布林(位置%/带宽) · MA5/20 方向 · 量能 · 洗盘vs派发。
 *
 * 个股因子的标的从 params.code 取 —— FactorContext 只有 { view, params }。
 */
import type { DailyBar, FactorResult, FactorSpec } from "@/lib/contracts";
import {
  adjClose, barsUpTo, clamp, mean, pctChange, pnum, requireCode, round6, stdevPop, evalDate,
} from "@/lib/factors/util";

export interface Bands { mid: number; upper: number; lower: number; pos: number; width: number }

/**
 * 布林带。closes 传入的应当是复权后收盘价。
 * 样本不足直接返回 null：用 5 根算 20 日布林会给出一个"看起来能用"的错值。
 */
export function bollinger(closes: number[], n = 20, k = 2): Bands | null {
  if (closes.length < n) return null;
  const win = closes.slice(closes.length - n);
  const mid = mean(win);
  const sd = stdevPop(win);
  const upper = mid + k * sd;
  const lower = mid - k * sd;
  const c = win[win.length - 1];
  // 横盘零波动时上下轨重合，pos 会是 0/0。取 50（等于中轨）而不是 NaN，
  // NaN 会一路污染到打分排序里，排序里出现 NaN 的结果是不稳定的。
  const pos = upper === lower ? 50 : (c - lower) / (upper - lower) * 100;
  return {
    mid: round6(mid), upper: round6(upper), lower: round6(lower),
    // 不 clamp 到 0~100：突破上轨时 pos > 100 本身就是信息，
    // clamp 会把"放量突破上轨"和"贴着上轨走"压成同一个值。
    pos: round6(pos),
    width: round6(mid === 0 ? 0 : (upper - lower) / mid * 100),
  };
}

export function ma(closes: number[], n: number): number | null {
  if (closes.length < n) return null;
  return round6(mean(closes.slice(closes.length - n)));
}

function closesOf(bars: DailyBar[]): number[] {
  return bars.map(adjClose);
}

function needBars(name: string, version: string, why: string): FactorResult<number | null> {
  return {
    name, version, value: null, label: why,
    provenance: "real", confidence: 0, inputs: { 缺失原因: why },
  };
}

const V = "1.0.0";

/* -------------------------------- 布林 -------------------------------- */

function bandsFactor(name: string, pick: (b: Bands) => number): FactorSpec<number | null> {
  return {
    name, version: V, group: "tech",
    defaults: { 周期: 20, 倍数: 2 },
    fn: ctx => {
      const code = requireCode(ctx.params, name);
      const date = evalDate(ctx.view, ctx.params);
      const n = pnum(ctx.params, "周期", 20);
      const k = pnum(ctx.params, "倍数", 2);
      const bars = barsUpTo(ctx.view, code, date, n);
      const b = bollinger(closesOf(bars), n, k);
      if (b === null) return needBars(name, V, `日线不足 ${n} 根，布林无法计算`);
      return {
        name, version: V, value: pick(b),
        label: b.pos >= 100 ? "上轨之上" : b.pos >= 80 ? "贴上轨" : b.pos >= 50 ? "中轨上方"
          : b.pos >= 20 ? "中轨下方" : "贴下轨",
        provenance: "real", confidence: 0.95,
        inputs: { 代码: code, 日期: date, 周期: n, 倍数: k, 中轨: b.mid, 上轨: b.upper, 下轨: b.lower, 位置: b.pos, 带宽: b.width },
      };
    },
  };
}

const 布林位置 = bandsFactor("布林位置", b => b.pos);
const 布林带宽 = bandsFactor("布林带宽", b => b.width);

/* ------------------------------ 均线方向 ------------------------------ */

/**
 * MA5/MA20 方向。取值 -2~2：
 *   2  多头排列（MA5 在 MA20 上方且两条都在上行）
 *   1  MA5 上穿但有一条走平/下行 —— 反弹但结构未确认
 *   0  纠缠
 *  -1  MA5 下方但均线还没同步向下
 *  -2  空头排列
 */
const 均线方向: FactorSpec<number> = {
  name: "均线方向", version: V, group: "tech",
  defaults: { 快线: 5, 慢线: 20, 斜率回溯: 3 },
  fn: ctx => {
    const code = requireCode(ctx.params, "均线方向");
    const date = evalDate(ctx.view, ctx.params);
    const fast = pnum(ctx.params, "快线", 5);
    const slow = pnum(ctx.params, "慢线", 20);
    const back = pnum(ctx.params, "斜率回溯", 3);
    const bars = barsUpTo(ctx.view, code, date, slow + back);
    const closes = closesOf(bars);

    const maFast = ma(closes, fast);
    const maSlow = ma(closes, slow);
    const maFastPrev = ma(closes.slice(0, closes.length - back), fast);
    const maSlowPrev = ma(closes.slice(0, closes.length - back), slow);

    if (maFast === null || maSlow === null || maFastPrev === null || maSlowPrev === null) {
      return {
        name: "均线方向", version: V, value: 0, label: "样本不足",
        provenance: "real", confidence: 0,
        inputs: { 代码: code, 日期: date, 日线根数: bars.length },
      };
    }

    const fastUp = maFast > maFastPrev;
    const slowUp = maSlow > maSlowPrev;
    const above = maFast > maSlow;
    const value = above ? (fastUp && slowUp ? 2 : 1) : (!fastUp && !slowUp ? -2 : -1);
    return {
      name: "均线方向", version: V, value,
      label: value === 2 ? "多头排列" : value === 1 ? "反弹未确认" : value === -1 ? "反抽未破位" : "空头排列",
      provenance: "real", confidence: 0.95,
      inputs: { 代码: code, 日期: date, MA快: maFast, MA慢: maSlow, 快线上行: fastUp, 慢线上行: slowUp },
    };
  },
};

/* -------------------------------- 量能 -------------------------------- */

const 量能: FactorSpec<number | null> = {
  name: "量能", version: V, group: "tech",
  defaults: { 基准回溯: 5, 巨量倍数: 2, 放量倍数: 1.3, 缩量倍数: 0.7, 地量倍数: 0.4 },
  fn: ctx => {
    const code = requireCode(ctx.params, "量能");
    const date = evalDate(ctx.view, ctx.params);
    const back = pnum(ctx.params, "基准回溯", 5);
    const bars = barsUpTo(ctx.view, code, date, back + 1);
    if (bars.length < back + 1) return needBars("量能", V, `日线不足 ${back + 1} 根，量比无基准`);

    const cur = bars[bars.length - 1];
    const base = mean(bars.slice(0, bars.length - 1).map(b => b.vol));
    if (base <= 0) return needBars("量能", V, "基准成交量为 0（长期停牌？）");
    const ratio = round6(cur.vol / base);
    return {
      name: "量能", version: V, value: ratio,
      label: ratio >= pnum(ctx.params, "巨量倍数", 2) ? "巨量"
        : ratio >= pnum(ctx.params, "放量倍数", 1.3) ? "放量"
          : ratio <= pnum(ctx.params, "地量倍数", 0.4) ? "地量"
            : ratio <= pnum(ctx.params, "缩量倍数", 0.7) ? "缩量" : "温和",
      provenance: "real", confidence: 0.95,
      inputs: { 代码: code, 日期: date, 当日量: cur.vol, 基准均量: round6(base), 基准回溯: back },
    };
  },
};

/* ---------------------------- 洗盘 vs 派发 ---------------------------- */

/**
 * 洗盘 vs 派发（>0 洗盘，<0 派发）。
 *
 * 这个因子存在的理由是一类反复出现的误判：在政策底或外围硬驱动的反弹日里，
 * 把盘中一次冲高回落读成"见光死"而砍在洗盘的最低点。
 * 结论是：**"冲高回落"本身不是判据**。在有硬驱动的反弹日里，单次冲高回落
 * 更可能是洗盘。真正的判据是三件事：
 *   1. 量能 —— 缩量回落是洗盘（没人真在卖），巨量回落才是派发（有人在出货）
 *   2. 收盘在日内区间的位置 —— 收在中上部说明抛压被接住了，收在最低才是溃败
 *   3. 结构 —— 还站在 MA5/MA20 上方就没坏，跌破才谈派发
 * 再叠一个位置修正：**已经走完一大波**的高位巨量长上影，派发概率显著更高，
 * 低位横盘出同样的形态则几乎都是洗。
 */
const 洗盘vs派发: FactorSpec<number> = {
  name: "洗盘vs派发", version: V, group: "tech",
  defaults: {
    量能基准回溯: 5, 区间回溯: 20, 高位区间涨幅: 50,
    收盘位置权重: 80, 量能权重: 25, 量能中性倍数: 1.5,
    站上快线加分: 15, 跌破快线扣分: 5, 站上慢线加分: 10, 跌破慢线扣分: 15,
    高位扣分: 20, 长上影阈值: 0.5, 长上影量能倍数: 1.8, 长上影扣分: 20,
    洗盘线: 25, 派发线: -25,
  },
  fn: ctx => {
    const code = requireCode(ctx.params, "洗盘vs派发");
    const date = evalDate(ctx.view, ctx.params);
    const back = pnum(ctx.params, "区间回溯", 20);
    const bars = barsUpTo(ctx.view, code, date, back + 2);
    if (bars.length < 3) {
      return {
        name: "洗盘vs派发", version: V, value: 0, label: "样本不足",
        provenance: "real", confidence: 0, inputs: { 代码: code, 日期: date, 日线根数: bars.length },
      };
    }

    const cur = bars[bars.length - 1];
    const closes = closesOf(bars);
    const range = cur.h - cur.l;
    // 一字板 h==l 时"收盘位置"无意义，取 0.5 中性，判据交给量能与结构
    const closePos = range <= 0 ? 0.5 : (cur.c - cur.l) / range;
    const upperShadow = range <= 0 ? 0 : (cur.h - Math.max(cur.o, cur.c)) / range;

    const volBase = mean(bars.slice(Math.max(0, bars.length - 1 - pnum(ctx.params, "量能基准回溯", 5)), bars.length - 1).map(b => b.vol));
    const volRatio = volBase <= 0 ? 1 : cur.vol / volBase;

    const maFast = ma(closes, 5);
    const maSlow = ma(closes, 20);

    // 位置用"区间涨幅"(近 N 日最高收盘 / 最低收盘 - 1)，不是"近 N 日涨幅"。
    // 派发发生在**涨过一大波之后**，而今天大跌会把"近 N 日涨幅"压低，
    // 用后者会恰好在派发日判成"位置不高"，正好判反。
    const win = closes.slice(Math.max(0, closes.length - back));
    const range20 = Math.min(...win) <= 0 ? 0 : (Math.max(...win) / Math.min(...win) - 1) * 100;

    const 收盘位置分 = (closePos - 0.5) * pnum(ctx.params, "收盘位置权重", 80);
    const 量能分 = clamp(pnum(ctx.params, "量能中性倍数", 1.5) - volRatio, -1, 1) * pnum(ctx.params, "量能权重", 25);
    const 快线分 = maFast === null ? 0
      : (adjClose(cur) > maFast ? pnum(ctx.params, "站上快线加分", 15) : -pnum(ctx.params, "跌破快线扣分", 5));
    const 慢线分 = maSlow === null ? 0
      : (adjClose(cur) > maSlow ? pnum(ctx.params, "站上慢线加分", 10) : -pnum(ctx.params, "跌破慢线扣分", 15));
    const 高位分 = range20 >= pnum(ctx.params, "高位区间涨幅", 50) ? -pnum(ctx.params, "高位扣分", 20) : 0;
    const 长上影分 = (upperShadow >= pnum(ctx.params, "长上影阈值", 0.5)
      && volRatio >= pnum(ctx.params, "长上影量能倍数", 1.8))
      ? -pnum(ctx.params, "长上影扣分", 20) : 0;

    const value = round6(clamp(收盘位置分 + 量能分 + 快线分 + 慢线分 + 高位分 + 长上影分, -100, 100));
    const 洗盘线 = pnum(ctx.params, "洗盘线", 25);
    const 派发线 = pnum(ctx.params, "派发线", -25);
    return {
      name: "洗盘vs派发", version: V, value,
      label: value >= 洗盘线 ? "洗盘" : value <= 派发线 ? "派发" : "中性",
      provenance: "real",
      // 日线级判别本身有限：真正区分洗盘与派发要看分时承接，那需要分钟线（不可回补）
      confidence: 0.7,
      inputs: {
        代码: code, 日期: date,
        收盘位置: round6(closePos), 上影占比: round6(upperShadow), 量比: round6(volRatio),
        区间涨幅: round6(range20), MA5: maFast, MA20: maSlow,
        分项: {
          收盘位置分: round6(收盘位置分), 量能分: round6(量能分), 快线分, 慢线分, 高位分, 长上影分,
        },
      },
    };
  },
};

/* ------------------------------ 分时博弈 ------------------------------ */

/**
 * 分时博弈 = 收盘价相对当日分时均价的位置。
 *
 * 只能来自分钟线。分钟线**不可回补**（新浪只给最近 1023 根，没有 end-date 参数），
 * 所以历史日期基本拿不到 —— 拿不到就返回 null + confidence 0，
 * 不用日线的"收盘在日内区间的位置"冒充分时均价（那是另一个量，会系统性偏乐观）。
 */
const 分时博弈: FactorSpec<number | null> = {
  name: "分时博弈", version: V, group: "tech",
  defaults: { 周期: 5, 条数: 60, 尾盘条数: 6 },
  fn: ctx => {
    const code = requireCode(ctx.params, "分时博弈");
    const period = pnum(ctx.params, "周期", 5);
    const n = pnum(ctx.params, "条数", 60);
    const bars = ctx.view.minuteBars(code, period, n);
    if (bars.length === 0) return needBars("分时博弈", V, "无分钟线（不可回补），分时博弈无法还原");

    const volSum = bars.reduce((a, b) => a + b.vol, 0);
    const vwap = volSum > 0
      ? bars.reduce((a, b) => a + b.c * b.vol, 0) / volSum
      : mean(bars.map(b => b.c));
    const close = bars[bars.length - 1].c;
    const tailN = Math.min(pnum(ctx.params, "尾盘条数", 6), bars.length);
    const tail = bars.slice(bars.length - tailN);
    const tailPct = round6(pctChange(tail[0].o === 0 ? tail[0].c : tail[0].o, close));

    const value = round6(vwap === 0 ? 0 : (close - vwap) / vwap * 100);
    return {
      name: "分时博弈", version: V, value,
      label: value > 0 ? "强于分时均价" : value < 0 ? "弱于分时均价" : "贴均价",
      provenance: "real", confidence: 0.9,
      inputs: { 代码: code, 周期: period, 条数: bars.length, 分时均价: round6(vwap), 收盘: close, 尾盘涨幅: tailPct },
    };
  },
};

export const TECH_FACTORS: FactorSpec<any>[] = [
  布林位置, 布林带宽, 均线方向, 量能, 洗盘vs派发, 分时博弈,
];
