import type { PointInTimeView } from "@/lib/contracts";

/**
 * 数据完整的最近交易日。
 *
 * 当天日线要等夜间全量拉取（22:00）才落库，所以盘中「今天」这一格是空的。
 * 横截面因子（涨跌家数、涨停家数、盘面强度……）判的是 `bar.date === 评估日`，
 * 拿一个还没有数据的今天去判，结果是全市场 5,888 只票全部落进 unknown，
 * 涨跌家数归零、盘面强度退回占位值 50 —— 低于进攻阈值 65，
 * **档位整个交易日卡在中性、候选池恒为空**。这是实测出来的：同一个库，
 * asOf 落在昨天收盘后得到「进攻 / 2 只候选 / 强度 66.2」，落在今天任意时刻都是
 * 「中性 / 0 候选 / 强度 50」，分水岭是 09:35 那轮采集把今天写进交易日历的一刻。
 *
 * 判据用**宇宙里的一小撮真实标的**，取它们最新一根日线的最大日期。
 * 不用指数（sh000001）—— 日线采集只拉 6 位代码，指数序列压根不在库里，
 * 拿它当探针会永远返回空、回落永远不触发（踩过）。
 * 取样而不是只看一只：单只可能停牌；取最大值而不是要求全体一致：
 * 只要有票已经有今天的日线，今天就算落库了。
 *
 * 回放历史某天时这个函数是恒等的 —— 那天的数据本来就完整，不会悄悄退一天，
 * 所以回测行为不受影响。
 */
export function completeDate(view: PointInTimeView, date: string, sample = 8): string {
  const d = String(date).slice(0, 10);
  const codes = view.universe();
  if (codes.length === 0) return d;

  // 跨整个列表等距取样，避开"开头一段恰好都停牌"这种巧合
  const stride = Math.max(1, Math.floor(codes.length / sample));
  let best: string | null = null;
  for (let i = 0; i < codes.length && (best === null || best !== d); i += stride) {
    const bars = view.dailyBars(codes[i].code, 1);
    const last = bars.length > 0 ? bars[bars.length - 1].date : null;
    if (last !== null && (best === null || last > best)) best = last;
  }
  // 一根都没取到：不猜，原样返回。空库/新装时退一天只会让人更难查
  return best === null ? d : (best > d ? d : best);
}
