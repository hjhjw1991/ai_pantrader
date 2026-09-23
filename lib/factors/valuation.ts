/**
 * 估值分位：PE 在申万一级行业内的横截面分位，同行不足时退回全市场。
 *
 * 为什么按行业比：同样 PE 30，在半导体里偏便宜，在银行里是最贵的那一撮。
 * 拿全市场一把尺子量，银行永远"便宜"、半导体永远"贵"，筛子就成了行业筛。
 *
 * 粗筛定位：候潮只做资金跑出来的龙头，本就不看便宜。这道筛只防行业里估值最离谱的
 * 那一撮 —— 纯概念炒作到同行几倍 PE 的票，资金一撤就是深渊。
 *
 * 数据只有**当日快照**（东财没有历史 PE 接口，2026-09-23 起攒），
 * 所以更早的日期如实返回"无估值数据"，回测里这道筛在那段是未判定。
 */
import type { FactorSpec } from "@/lib/contracts";
import { pnum, requireCode, round6, evalDate } from "@/lib/factors/util";
import { percentileRank } from "@/lib/factors/sentiment";

const V = "1.0.0";

function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b), m = s.length >> 1;
  return s.length % 2 === 1 ? s[m] : (s[m - 1] + s[m]) / 2;
}

const 估值分位: FactorSpec<number | null> = {
  name: "估值分位", version: V, group: "filter",
  defaults: { 行业最少样本: 10, 最大滞后交易日: 5, 偏贵分位: 0.9, 偏便宜分位: 0.1 },
  fn: ctx => {
    const code = requireCode(ctx.params, "估值分位");
    const date = evalDate(ctx.view, ctx.params).slice(0, 10);
    const miss = (label: string, extra: Record<string, unknown> = {}) => ({
      name: "估值分位", version: V, value: null, label, provenance: "real" as const, confidence: 0,
      inputs: { 代码: code, 日期: date, ...extra },
    });

    const cs = ctx.view.valuationCrossSection();
    if (cs === null) return miss("无估值数据");
    // 视图给的是"不晚于 asOf"的快照；回放时评估日早于 asOf，晚于评估日的快照就是未来数据
    if (cs.date > date) return miss("无估值数据", { 快照日: cs.date, 说明: "最近的快照晚于评估日" });
    const lag = cs.date >= date ? 0 : Math.max(0, ctx.view.tradingDays(cs.date, date).length - 1);
    if (lag > pnum(ctx.params, "最大滞后交易日", 5)) return miss("估值过旧", { 快照日: cs.date, 滞后交易日: lag });

    const self = cs.rows.find(r => r.code === code);
    if (self === undefined) return miss("无该股估值", { 快照日: cs.date });
    if (self.pe === null) return miss("无PE", { 快照日: cs.date });
    if (self.pe <= 0) {
      // 亏损是真实读数，不是缺数据：置信 1。要不要否决交给筛子的参数
      return { name: "估值分位", version: V, value: null, label: "亏损", provenance: "real", confidence: 1,
        inputs: { 代码: code, 日期: date, 快照日: cs.date, PE: self.pe } };
    }

    const ind = new Map(ctx.view.industryCrossSection(1).map(r => [r.code, r.indexName]));
    const myInd = ind.get(code) ?? null;
    const positive = cs.rows.filter(r => r.code !== code && r.pe !== null && r.pe > 0);
    const sameInd = myInd === null ? [] : positive.filter(r => ind.get(r.code) === myInd);
    const useInd = sameInd.length >= pnum(ctx.params, "行业最少样本", 10);
    const peers = (useInd ? sameInd : positive).map(r => r.pe as number);

    const p = percentileRank(peers, self.pe);
    const med = median(peers);
    if (p === null || med === null) return miss("无同行样本", { 快照日: cs.date });
    const label = p >= pnum(ctx.params, "偏贵分位", 0.9) ? "偏贵"
      : p <= pnum(ctx.params, "偏便宜分位", 0.1) ? "偏便宜" : "适中";
    return {
      name: "估值分位", version: V, value: p, label, provenance: "real", confidence: 1,
      inputs: {
        代码: code, 日期: date, 快照日: cs.date, PE: self.pe,
        口径: useInd ? "行业" : "全市场", 行业: myInd, 样本: peers.length,
        同行中位PE: round6(med), 相对中位: round6(self.pe / med),
      },
    };
  },
};

export const VALUATION_FACTORS: FactorSpec<any>[] = [估值分位];
