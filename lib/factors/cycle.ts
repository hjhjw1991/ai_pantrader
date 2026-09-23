/**
 * 情绪周期因子：读情绪截面派生表（sentimentHistory），给出当日读数与它在近 250 日里的分位。
 *
 * 值是**原始读数**（晋级率 0.23、溢价 +1.8 个百分点），不是打分。
 * 标签看分位而不是看固定阈值：同样 20% 的首板晋级率，在 2024-10 那种狂热里是冷，
 * 在 2024-01 那种冰点里是热。固定阈值今年调好了明年就错，分位跟着市场自己的尺子走。
 *
 * 这批因子暂不接进档位判定：五段状态机（②期4）会把几条分位合起来判阶段，
 * 单条分位直接驱动仓位，等于拿一个维度的温度计决定穿几件衣服。
 */
import type { CycleStage, FactorResult, FactorSpec, SentimentRow } from "@/lib/contracts";
import { mean, pnum, round6, stdevPop, evalDate } from "@/lib/factors/util";
import { percentileRank } from "@/lib/factors/sentiment";

const V = "1.0.0";
/** 日线重建的基准置信度。涨停判定已对过真快照（31 天中 17 天逐只一致，其余差 1~2 家） */
const BASE_CONF = 0.8;

type Key = keyof SentimentRow;

interface CycleDef {
  name: string;
  key: Key;
  /** 分母字段：分母太小时读数是噪声，置信打折 */
  denom?: (r: SentimentRow) => number;
  extra?: (r: SentimentRow) => Record<string, unknown>;
  what: string;
}

function makeCycleFactor(d: CycleDef): FactorSpec<number | null> {
  return {
    name: d.name, version: V, group: "env",
    defaults: { 分位窗口: 250, 最少样本: 60, 偏热分位: 0.8, 偏冷分位: 0.2, 最小分母: 5 },
    fn: ctx => {
      const date = evalDate(ctx.view, ctx.params).slice(0, 10);
      const w = Math.max(1, Math.floor(pnum(ctx.params, "分位窗口", 250)));
      // 回放时评估日早于 asOf：多取一段再按评估日截断，否则窗口会被 asOf 之后的行挤掉
      const behind = date === ctx.view.asOf.slice(0, 10) ? 0 : ctx.view.tradingDays(date, ctx.view.asOf).length;
      const rows = ctx.view.sentimentHistory(w + behind + 1).filter(r => r.date <= date).slice(-w);
      const today = rows.length > 0 ? rows[rows.length - 1] : null;
      const out = (value: number | null, label: string, confidence: number, inputs: Record<string, unknown>): FactorResult<number | null> =>
        ({ name: d.name, version: V, value, label, provenance: "proxy", confidence: round6(confidence), inputs: { 日期: date, 口径: d.what, ...inputs } });

      if (today === null || today.date !== date) {
        return out(null, "未构建", 0, { 最新行: today?.date ?? null });
      }
      const raw = today[d.key];
      const v = typeof raw === "number" ? raw : null;
      const denom = d.denom?.(today) ?? null;
      const extra = d.extra?.(today) ?? {};
      if (v === null) return out(null, "无样本", 0, { 分母: denom, ...extra });

      let conf = BASE_CONF;
      if (denom !== null && denom < pnum(ctx.params, "最小分母", 5)) conf *= 0.5;
      const series = rows.map(r => r[d.key]).filter((x): x is number => typeof x === "number");
      if (series.length < pnum(ctx.params, "最少样本", 60)) {
        return out(v, "样本不足", conf * 0.5, { 分位: null, 样本: series.length, 分母: denom, ...extra });
      }
      const p = percentileRank(series, v);
      const label = p === null ? "样本不足"
        : p >= pnum(ctx.params, "偏热分位", 0.8) ? "偏热"
        : p <= pnum(ctx.params, "偏冷分位", 0.2) ? "偏冷" : "常态";
      return out(v, label, conf, { 分位: p, 样本: series.length, 分母: denom, ...extra });
    },
  };
}

/* -------------------------------- 五段状态机 -------------------------------- */

export interface StageOpts {
  /** 热度分位上沿 / 下沿 / 中线 */
  hi: number; lo: number; mid: number;
  /** "明显变化"的幅度。由调用方从数据里学（热度日变化的标准差），不写死 */
  delta: number;
  /** 变化看几天前 */
  lookback: number;
  /** 滞回带宽：出高潮要跌破 hi − band，出冰点要升过 lo + band。默认 0 */
  band?: number;
}

/**
 * 五段状态机。输入是每日热度（0~1 的分位），输出每日阶段。
 *
 * 规则分两层：
 *   - 水平优先：热度 ≥ hi 一律高潮，≤ lo 一律冰点，不管从哪来
 *   - 中间区域看**来路与方向**，这才是"状态机"而不是"分档"：
 *       冰点 → 明显回升 → 启动
 *       启动 → 升过中线且不回落 → 发酵；明显回落 → 退潮
 *       发酵 → 明显回落 → 退潮
 *       高潮 → 一跌出 hi → 退潮（高潮之后的中位区间就是退潮，不是发酵）
 *       退潮 → 明显反弹 → 启动（新一轮）
 *     其余情况**维持上一阶段**。信号不明时不切换，避免同一段行情里来回跳 ——
 *     影子盘按阶段分组统计，频繁跳动会把每组都切成碎片。
 *
 * null（那天分项不足）沿用上一阶段；开头就是 null 的位置返回 null。
 */
export function runStages(heat: Array<number | null>, o: StageOpts): Array<CycleStage | null> {
  const out: Array<CycleStage | null> = [];
  let prev: CycleStage | null = null;
  for (let t = 0; t < heat.length; t++) {
    const h = heat[t];
    if (h === null) { out.push(prev); continue; }
    const back = t - o.lookback >= 0 ? heat[t - o.lookback] : null;
    const d = back === null ? 0 : h - back;
    const up = d >= o.delta - 1e-12, down = d <= -o.delta + 1e-12;
    const band = o.band ?? 0;
    let s: CycleStage;
    if (h >= o.hi) s = "高潮";
    else if (h <= o.lo) s = "冰点";
    // 滞回：已经在高潮 / 冰点里，要越过带宽才算出来
    else if (prev === "高潮" && h >= o.hi - band) s = "高潮";
    else if (prev === "冰点" && h <= o.lo + band) s = "冰点";
    else if (prev === null) s = h >= o.mid ? "发酵" : "启动";
    else if (prev === "冰点") s = up ? "启动" : "冰点";
    else if (prev === "启动") s = down ? "退潮" : (h >= o.mid && d >= 0 ? "发酵" : "启动");
    else if (prev === "发酵") s = down ? "退潮" : "发酵";
    else if (prev === "高潮") s = "退潮";
    else s = up ? "启动" : "退潮";
    out.push(s);
    prev = s;
  }
  return out;
}

/**
 * 进综合热度的分项与方向。炸板率是反向的：炸板越多越冷。
 * 七项等权 —— 在有足够的阶段样本之前，任何加权都是拍脑袋；等权至少是可解释的拍脑袋。
 */
const HEAT_PARTS: Array<{ name: string; key: Key; invert?: boolean }> = [
  { name: "首板晋级率", key: "firstPromo" }, { name: "连板晋级率", key: "multiPromo" },
  { name: "涨停溢价", key: "ztPrem" }, { name: "高度板溢价", key: "highPrem" },
  { name: "炸板溢价", key: "zbPrem" }, { name: "日线炸板率", key: "zbRate", invert: true },
  { name: "涨跌中位数", key: "medianPct" },
];

/**
 * 情绪阶段：七项情绪分位合成综合热度，热度再相对自己的 250 日历史取分位，喂给五段状态机。
 *
 * 为什么要"分位的分位"：七个 [0,1] 分位取平均会往 0.5 挤（独立时方差只剩 1/7），
 * 直接拿 0.8 当高潮线几乎永远碰不到。再相对自身历史排一次，高潮 = "综合热度在近一年里前 20%"，
 * 阈值跟着市场自己的尺度走 —— 这就是"阈值由数据学"。
 */
const 情绪阶段: FactorSpec<number | null> = {
  name: "情绪阶段", version: V, group: "env",
  defaults: {
    分位窗口: 250, 最少样本: 60, 轨迹天数: 60, 最少分项: 4, 平滑天数: 5,
    高潮分位: 0.8, 冰点分位: 0.2, 中线: 0.5, 回看天数: 3, δ系数: 0.5, 最小δ: 0.03, 滞回带宽: 0.1,
  },
  fn: ctx => {
    const date = evalDate(ctx.view, ctx.params).slice(0, 10);
    const W = Math.max(10, Math.floor(pnum(ctx.params, "分位窗口", 250)));
    const minS = Math.max(2, Math.floor(pnum(ctx.params, "最少样本", 60)));
    const T = Math.max(5, Math.floor(pnum(ctx.params, "轨迹天数", 60)));
    const behind = date === ctx.view.asOf.slice(0, 10) ? 0 : ctx.view.tradingDays(date, ctx.view.asOf).length;
    const rows = ctx.view.sentimentHistory(2 * W + T + behind).filter(r => r.date <= date).slice(-(2 * W + T));
    const n = rows.length;
    const out = (value: number | null, label: string, confidence: number, inputs: Record<string, unknown>): FactorResult<number | null> =>
      ({ name: "情绪阶段", version: V, value, label, provenance: "proxy", confidence: round6(confidence), inputs: { 日期: date, ...inputs } });

    if (n === 0 || rows[n - 1].date !== date) return out(null, "未构建", 0, { 最新行: n > 0 ? rows[n - 1].date : null });
    if (n < W + minS + T) return out(null, "样本不足", 0, { 行数: n, 需要: W + minS + T });

    /* 1. 每天每个分项相对它自己近 W 日的分位 → 综合热度 H */
    const minParts = pnum(ctx.params, "最少分项", 4);
    const firstH = Math.max(minS - 1, n - T - W);
    const H: Array<number | null> = Array(n).fill(null);
    const partsAt = (t: number): Record<string, number | null> => {
      const o: Record<string, number | null> = {};
      for (const p of HEAT_PARTS) {
        const v = rows[t][p.key];
        if (typeof v !== "number") { o[p.name] = null; continue; }
        const win: Array<number | null> = [];
        for (let i = Math.max(0, t - W + 1); i <= t; i++) { const x = rows[i][p.key]; win.push(typeof x === "number" ? x : null); }
        const q = win.filter(x => x !== null).length >= minS ? percentileRank(win, v) : null;
        o[p.name] = q === null ? null : (p.invert ? round6(1 - q) : q);
      }
      return o;
    };
    for (let t = firstH; t < n; t++) {
      const qs = Object.values(partsAt(t)).filter((x): x is number => x !== null);
      H[t] = qs.length >= minParts ? mean(qs) : null;
    }
    /**
     * 平滑：日度的溢价、晋级率噪声很大，不平滑时实测平均每个阶段只持续 1.7 天，
     * 冰点与高潮隔天互换 —— 那不是情绪周期，是日间噪声。EMA 首值取第一个非空值。
     */
    const span = Math.max(1, Math.floor(pnum(ctx.params, "平滑天数", 5)));
    const a = 2 / (span + 1);
    let ema: number | null = null;
    for (let t = firstH; t < n; t++) {
      const h = H[t];
      if (h === null) continue;
      ema = ema === null ? h : a * h + (1 - a) * ema;
      H[t] = ema;
    }

    /* 2. 热度 = H 相对自己近 W 日的分位（只算最后 T 天） */
    const HP: Array<number | null> = [];
    for (let t = n - T; t < n; t++) {
      const h = H[t];
      const win = H.slice(Math.max(0, t - W + 1), t + 1);
      HP.push(h === null || win.filter(x => x !== null).length < minS ? null : percentileRank(win, h));
    }
    const hpNow = HP[HP.length - 1];
    if (hpNow === null) return out(null, "样本不足", 0, { 说明: "当日热度分位算不出来" });

    /* 3. δ 从数据学：热度 lookback 日变化的标准差 × 系数 */
    const lb = Math.max(1, Math.floor(pnum(ctx.params, "回看天数", 3)));
    const diffs: number[] = [];
    for (let i = lb; i < HP.length; i++) { const a = HP[i], b = HP[i - lb]; if (a !== null && b !== null) diffs.push(a - b); }
    const delta = Math.max(pnum(ctx.params, "最小δ", 0.03), pnum(ctx.params, "δ系数", 0.5) * (diffs.length > 1 ? stdevPop(diffs) : 0));

    const stages = runStages(HP, {
      hi: pnum(ctx.params, "高潮分位", 0.8), lo: pnum(ctx.params, "冰点分位", 0.2),
      mid: pnum(ctx.params, "中线", 0.5), delta, lookback: lb, band: pnum(ctx.params, "滞回带宽", 0.1),
    });
    const now = stages[stages.length - 1];
    if (now === null) return out(null, "样本不足", 0, {});
    let run = 0;
    for (let i = stages.length - 1; i >= 0 && stages[i] === now; i--) run++;

    return out(round6(hpNow), now, BASE_CONF, {
      热度: round6(hpNow), 综合: H[n - 1] === null ? null : round6(H[n - 1] as number),
      分项分位: partsAt(n - 1), δ: round6(delta), 持续天数: run,
      轨迹: stages.slice(-10).map((s, i) => {
        const k = stages.length - 10 + i;
        return { 日期: rows[n - T + k].date, 阶段: s, 热度: HP[k] === null ? null : round6(HP[k] as number) };
      }),
    });
  },
};

export const CYCLE_FACTORS: FactorSpec<any>[] = [
  情绪阶段,
  makeCycleFactor({
    name: "首板晋级率", key: "firstPromo", denom: r => r.firstPrev,
    what: "昨日首板（非 ST）今日再涨停的比例",
  }),
  makeCycleFactor({
    name: "连板晋级率", key: "multiPromo", denom: r => r.multiPrev,
    what: "昨日 ≥2 板今日继续涨停的比例",
  }),
  makeCycleFactor({
    name: "涨停溢价", key: "ztPrem", denom: r => r.firstPrev + r.multiPrev,
    what: "昨日涨停股今日收盘涨幅均值（百分点）",
    extra: r => ({ 开盘溢价: r.ztOpenPrem, 首板溢价: r.firstPrem, 连板溢价: r.multiPrem, 炸板溢价: r.zbPrem }),
  }),
  makeCycleFactor({
    name: "高度板溢价", key: "highPrem",
    what: "昨日最高板（≥2 板）今日涨幅（百分点）",
    extra: r => ({ 昨日最高板: r.highLbcPrev, 今日最高板: r.maxLbc }),
  }),
  makeCycleFactor({
    name: "炸板溢价", key: "zbPrem",
    what: "昨日炸板股今日涨幅均值（百分点）",
  }),
  makeCycleFactor({
    name: "日线炸板率", key: "zbRate", denom: r => r.zt + r.zb,
    what: "炸板 /（涨停 + 炸板），日线口径，开板回封的算涨停，所以是下界",
    extra: r => ({ 涨停: r.zt, 炸板: r.zb }),
  }),
  makeCycleFactor({
    name: "涨跌中位数", key: "medianPct",
    what: "全市场当日涨跌幅中位数（百分点，含 ST）",
    extra: r => ({ 上涨: r.up, 下跌: r.down }),
  }),
];
