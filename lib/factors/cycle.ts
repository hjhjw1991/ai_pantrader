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
import type { FactorResult, FactorSpec, SentimentRow } from "@/lib/contracts";
import { pnum, round6, evalDate } from "@/lib/factors/util";
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

export const CYCLE_FACTORS: FactorSpec<any>[] = [
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
