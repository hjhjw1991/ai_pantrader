/**
 * 资金面 / 供给面因子：两融、互联互通、已实施增减持。
 *
 * 这一批目前只**产出读数**，不接进档位判定与选股否决：
 * 阈值是先拍的（1% / 10% / 1.3 倍 …），在滚动分位学出来之前接进决策，
 * 等于拿一个没校准过的数去左右仓位。先让它们上卡片、进影子盘，攒够样本再说。
 *
 * 时点纪律都在 PIT 视图里：两融与互联互通只给**严格早于评估日**的数据
 * （T+1 才发布），增减持按公告日。因子这一层不再自己判日期。
 */
import type { FactorSpec } from "@/lib/contracts";
import { mean, pnum, requireCode, round6, evalDate } from "@/lib/factors/util";
import { percentileRank } from "@/lib/factors/sentiment";

const V = "1.0.0";

/** 两个 YYYY-MM-DD 之间差几个自然日（b − a）。纯字符串运算，不碰系统时钟 */
function dayDiff(a: string, b: string): number {
  const p = (s: string) => {
    const [y, m, d] = s.slice(0, 10).split("-").map(Number);
    return Date.UTC(y, m - 1, d);
  };
  return Math.round((p(b) - p(a)) / 86_400_000);
}

/** 窗口首尾的变化率。任一端缺失或首值 ≤ 0 返回 null —— 拿 0 当分母不是"没变化" */
function changeRate(first: number | null, last: number | null): number | null {
  if (first === null || last === null || first <= 0) return null;
  return (last - first) / first;
}

/** 每个位置上"窗口 w 的变化率"序列（前 w 个位置没有） */
function rollingChanges(xs: Array<number | null>, w: number): number[] {
  const out: number[] = [];
  for (let i = w; i < xs.length; i++) {
    const c = changeRate(xs[i - w], xs[i]);
    if (c !== null) out.push(c);
  }
  return out;
}

/**
 * 分位口径：历史样本够长时，标签看当前读数在自身历史里的分位；不够长就回落固定阈值。
 *
 * 为什么不直接用固定阈值：两融余额 5 日 +1% 在 2024-10 是平淡，在 2024-01 是罕见的加杠杆。
 * 固定线今年调好了，明年市场换了量级就错。固定阈值只留作样本不足时的兜底，
 * 并且在 inputs 里写明这次用的是哪种口径 —— 两种口径的标签不能混着读。
 */
function pctMode(
  params: Record<string, unknown>, series: number[], v: number
): { 口径: "分位" | "固定阈值"; 分位: number | null } {
  if (series.length < pnum(params, "最少样本", 60)) return { 口径: "固定阈值", 分位: null };
  return { 口径: "分位", 分位: percentileRank(series, v) };
}

/* ------------------------------- 两融情绪 ------------------------------- */

/**
 * 全市场融资余额在窗口内的变化率。
 *
 * 看余额而不是看单日净买入：单日净买入噪声很大（月末、指数调整日都会跳），
 * 而余额的趋势才是"杠杆资金在进还是在退"。窗口净买入放进 inputs 给人看。
 *
 * 数据过旧（最新一条离评估日 > 10 个自然日）直接置信 0：长假前后最多隔 8 天，
 * 超过 10 天只能是采集断了，拿两周前的杠杆状态判断今天是误导。
 */
const 两融情绪: FactorSpec<number> = {
  name: "两融情绪", version: V, group: "env",
  defaults: {
    窗口: 5, 加杠杆阈值: 0.01, 去杠杆阈值: -0.01, 最大滞后天数: 10,
    分位窗口: 250, 最少样本: 60, 高分位: 0.8, 低分位: 0.2,
  },
  fn: ctx => {
    const date = evalDate(ctx.view, ctx.params);
    const w = Math.max(1, Math.floor(pnum(ctx.params, "窗口", 5)));
    const hist = ctx.view.marginMarket(w + 1 + Math.max(0, Math.floor(pnum(ctx.params, "分位窗口", 250))));
    const rows = hist.slice(-(w + 1));
    if (rows.length < 2) {
      return { name: "两融情绪", version: V, value: 0, label: "无数据", provenance: "real",
        confidence: 0, inputs: { 日期: date, 样本: rows.length } };
    }
    const last = rows[rows.length - 1];
    const lag = dayDiff(last.date, date);
    const inputs = {
      日期: date, 最新日期: last.date, 滞后天数: lag,
      融资余额: last.rzye, 占流通: last.rzyezb,
      窗口净买入: round6(rows.slice(1).reduce((a, r) => a + (r.rzjme ?? 0), 0)),
    };
    if (lag > pnum(ctx.params, "最大滞后天数", 10)) {
      return { name: "两融情绪", version: V, value: 0, label: "数据过旧", provenance: "real",
        confidence: 0, inputs };
    }
    const chg = changeRate(rows[0].rzye, last.rzye);
    if (chg === null) {
      return { name: "两融情绪", version: V, value: 0, label: "无数据", provenance: "real",
        confidence: 0, inputs };
    }
    const m = pctMode(ctx.params, rollingChanges(hist.map(r => r.rzye), w), chg);
    const up = pnum(ctx.params, "加杠杆阈值", 0.01), dn = pnum(ctx.params, "去杠杆阈值", -0.01);
    const hi = pnum(ctx.params, "高分位", 0.8), lo = pnum(ctx.params, "低分位", 0.2);
    const label = m.分位 !== null
      ? (m.分位 >= hi ? "加杠杆" : m.分位 <= lo ? "去杠杆" : "平稳")
      : (chg >= up ? "加杠杆" : chg <= dn ? "去杠杆" : "平稳");
    return { name: "两融情绪", version: V, value: round6(chg), label, provenance: "real",
      confidence: 1, inputs: { ...inputs, ...m } };
  },
};

/* ------------------------------- 个股融资 ------------------------------- */

/**
 * 个股融资余额的窗口变化率，外加拥挤度（融资余额占流通市值）。
 *
 * 涌入不等于好事：融资盘是最先踩踏的那批。所以拥挤单独标出来 ——
 * "融资涌入·拥挤"意思是杠杆资金正在往一个已经很挤的地方挤。
 *
 * "非两融标的"是一个**事实**，置信 1；只有连全市场汇总都没有时才是"不知道"。
 */
const 个股融资: FactorSpec<number> = {
  name: "个股融资", version: V, group: "fund",
  defaults: {
    窗口: 5, 涌入阈值: 0.1, 撤离阈值: -0.1, 拥挤阈值: 0.1,
    分位窗口: 250, 最少样本: 60, 高分位: 0.8, 低分位: 0.2,
  },
  fn: ctx => {
    const code = requireCode(ctx.params, "个股融资");
    const date = evalDate(ctx.view, ctx.params);
    const w = Math.max(1, Math.floor(pnum(ctx.params, "窗口", 5)));
    const market = ctx.view.marginMarket(1);
    if (market.length === 0) {
      return { name: "个股融资", version: V, value: 0, label: "无数据", provenance: "real",
        confidence: 0, inputs: { 代码: code, 日期: date } };
    }
    const latest = market[0].date;
    const hist = ctx.view.marginStock(code, w + 1 + Math.max(0, Math.floor(pnum(ctx.params, "分位窗口", 250))));
    const rows = hist.slice(-(w + 1));
    if (rows.length === 0 || rows[rows.length - 1].date < latest) {
      return { name: "个股融资", version: V, value: 0, label: "非两融标的", provenance: "real",
        confidence: 1, inputs: { 代码: code, 日期: date, 汇总最新日: latest,
          个股最新日: rows.length > 0 ? rows[rows.length - 1].date : null } };
    }
    const last = rows[rows.length - 1];
    const crowded = last.rzyezb !== null && last.rzyezb >= pnum(ctx.params, "拥挤阈值", 0.1);
    const chg = rows.length >= 2 ? changeRate(rows[0].rzye, last.rzye) : null;
    const up = pnum(ctx.params, "涌入阈值", 0.1), dn = pnum(ctx.params, "撤离阈值", -0.1);
    const hi = pnum(ctx.params, "高分位", 0.8), lo = pnum(ctx.params, "低分位", 0.2);
    // 拥挤度仍是绝对线：它说的是"杠杆盘占了流通盘多少"，与这只票自己的历史无关
    const m = chg === null ? { 口径: "固定阈值" as const, 分位: null } : pctMode(ctx.params, rollingChanges(hist.map(r => r.rzye), w), chg);
    const base = chg === null ? "样本不足"
      : m.分位 !== null ? (m.分位 >= hi ? "融资涌入" : m.分位 <= lo ? "融资撤离" : "平稳")
      : chg >= up ? "融资涌入" : chg <= dn ? "融资撤离" : "平稳";
    return {
      name: "个股融资", version: V, value: chg === null ? 0 : round6(chg),
      label: crowded ? `${base}·拥挤` : base,
      provenance: "real", confidence: chg === null ? 0 : 1,
      inputs: { 代码: code, 日期: date, 最新日期: last.date, 融资余额: last.rzye,
        占流通: last.rzyezb, 拥挤: crowded, 样本: rows.length, ...m },
    };
  },
};

/* ------------------------------ 北向活跃度 ------------------------------ */

/**
 * 北向成交额相对前 N 日均值的倍数。**没有方向**。
 *
 * 2024-08-16 起北向净买额停止披露，剩下的成交额只能说明外资"忙不忙"，
 * 不能说明它"在买还是在卖"。放量既可能是抢筹也可能是撤退，
 * 所以这个因子只配当背景，永远不该单独驱动仓位。
 *
 * 南向净买额仍在披露，一并放进 inputs：内地资金大举南下时，A 股是被抽血的一方。
 */
const 北向活跃度: FactorSpec<number> = {
  name: "北向活跃度", version: V, group: "env",
  defaults: {
    均值窗口: 20, 最少样本: 5, 放量倍数: 1.3, 缩量倍数: 0.7,
    分位窗口: 250, 分位最少样本: 60, 高分位: 0.8, 低分位: 0.2,
  },
  fn: ctx => {
    const date = evalDate(ctx.view, ctx.params);
    const w = Math.max(1, Math.floor(pnum(ctx.params, "均值窗口", 20)));
    const all = ctx.view.mutualDeal(w + 1 + Math.max(0, Math.floor(pnum(ctx.params, "分位窗口", 250))));
    const allNorth = all.filter(r => r.mutualType === "005" && r.dealAmt !== null);
    const lastDates = new Set([...new Set(all.map(r => r.date))].slice(-(w + 1)));
    const rows = all.filter(r => lastDates.has(r.date));
    const north = rows.filter(r => r.mutualType === "005" && r.dealAmt !== null);
    const south = rows.filter(r => r.mutualType === "006");
    const lastSouth = south.length > 0 ? south[south.length - 1] : null;
    const lastNorth = north.length > 0 ? north[north.length - 1] : null;
    const inputs = {
      日期: date, 最新日期: lastNorth?.date ?? null, 北向成交额: lastNorth?.dealAmt ?? null,
      北向净买: lastNorth?.netAmt ?? null,
      南向净买: lastSouth?.netAmt ?? null, 样本: north.length,
    };
    if (north.length < Math.max(2, pnum(ctx.params, "最少样本", 5)) || lastNorth === null) {
      return { name: "北向活跃度", version: V, value: 0, label: "样本不足", provenance: "real",
        confidence: 0, inputs };
    }
    const prior = mean(north.slice(0, -1).map(r => r.dealAmt as number));
    if (!(prior > 0)) {
      return { name: "北向活跃度", version: V, value: 0, label: "样本不足", provenance: "real",
        confidence: 0, inputs };
    }
    const ratio = (lastNorth.dealAmt as number) / prior;
    // 每一天"当日 / 前 w 日均值"的历史序列，用来给今天的倍数排分位
    const amts = allNorth.map(r => r.dealAmt as number);
    const series: number[] = [];
    for (let i = w; i < amts.length; i++) {
      const m0 = mean(amts.slice(i - w, i));
      if (m0 > 0) series.push(amts[i] / m0);
    }
    const m = pctMode({ ...ctx.params, 最少样本: pnum(ctx.params, "分位最少样本", 60) }, series, ratio);
    const hi = pnum(ctx.params, "高分位", 0.8), lo = pnum(ctx.params, "低分位", 0.2);
    const label = m.分位 !== null
      ? (m.分位 >= hi ? "北向放量" : m.分位 <= lo ? "北向缩量" : "平常")
      : (ratio >= pnum(ctx.params, "放量倍数", 1.3) ? "北向放量"
        : ratio <= pnum(ctx.params, "缩量倍数", 0.7) ? "北向缩量" : "平常");
    return { name: "北向活跃度", version: V, value: round6(ratio), label, provenance: "real",
      confidence: 1, inputs: { ...inputs, ...m } };
  },
};

/* ------------------------------ 北向关注 ------------------------------ */

/**
 * 近 N 个自然日里上北向十大成交股的天数。同样**没有方向**，只说明外资在不在看它。
 */
const 北向关注: FactorSpec<number> = {
  name: "北向关注", version: V, group: "fund",
  defaults: { 回看天数: 10 },
  fn: ctx => {
    const code = requireCode(ctx.params, "北向关注");
    const date = evalDate(ctx.view, ctx.params);
    const days = Math.max(1, Math.floor(pnum(ctx.params, "回看天数", 10)));
    if (ctx.view.mutualDeal(1).length === 0) {
      return { name: "北向关注", version: V, value: 0, label: "无数据", provenance: "real",
        confidence: 0, inputs: { 代码: code, 日期: date } };
    }
    const hits = ctx.view.mutualTop10(code, days);
    const n = new Set(hits.map(h => h.date)).size;
    return {
      name: "北向关注", version: V, value: n, label: n > 0 ? "上榜" : "未上榜",
      provenance: "real", confidence: 1,
      inputs: { 代码: code, 日期: date, 回看天数: days,
        明细: hits.map(h => ({ 日期: h.date, 通道: h.mutualType, 名次: h.rank, 北向占比: h.mutualRatio })) },
    };
  },
};

/* ----------------------------- 股东增减持 ----------------------------- */

/**
 * 近 N 天（按公告日）已实施增减持的净额，占流通股比例，带符号。
 *
 * 与"减持计划"互补：那个是未来的抛压上界（只能从接入日起攒），
 * 这个是已经发生的事实（1994 年起可回补，所以能进回测）。
 * 一只票过去两个月被大股东连续减了 2% 流通盘，比它有没有新计划更能说明股东的态度。
 */
const 股东增减持: FactorSpec<number> = {
  name: "股东增减持", version: V, group: "fund",
  defaults: { 回看天数: 60, 大额比例: 0.02, 显著比例: 0.005 },
  fn: ctx => {
    const code = requireCode(ctx.params, "股东增减持");
    const date = evalDate(ctx.view, ctx.params);
    const days = Math.max(1, Math.floor(pnum(ctx.params, "回看天数", 60)));
    const xs = ctx.view.holderChanges(code, days);
    if (xs.length === 0) {
      return { name: "股东增减持", version: V, value: 0, label: "无", provenance: "real",
        confidence: 1, inputs: { 代码: code, 日期: date, 回看天数: days } };
    }
    const known = xs.filter(x => x.changeFreeRatio !== null);
    const net = round6(known.reduce((a, x) => a + (x.changeFreeRatio as number), 0));
    const big = pnum(ctx.params, "大额比例", 0.02), sig = pnum(ctx.params, "显著比例", 0.005);
    // 全部比例缺失时净额是 0，但那个 0 是"不知道"，不能叫"小额"
    const label = known.length === 0 ? "比例未知"
      : net <= -big ? "大额净减持" : net <= -sig ? "净减持" : net >= sig ? "净增持" : "小额";
    return {
      name: "股东增减持", version: V, value: net, label, provenance: "real",
      confidence: round6(known.length / xs.length),
      inputs: {
        代码: code, 日期: date, 回看天数: days,
        减持笔数: xs.filter(x => x.direction === "减持").length,
        增持笔数: xs.filter(x => x.direction === "增持").length,
        明细: xs.slice(-5).map(x => ({ 股东: x.holder, 方向: x.direction, 公告日: x.noticeDate, 占流通: x.changeFreeRatio })),
      },
    };
  },
};

export const CAPITAL_FACTORS: FactorSpec<any>[] = [两融情绪, 个股融资, 北向活跃度, 北向关注, 股东增减持];
