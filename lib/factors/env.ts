/**
 * 环境组因子（spec §8）：盘面强度 / 情绪温度 / 赚钱效应 / 连板高度。
 *
 * 这四个都是**日线代理重建**，不是真值，所以一律 provenance: "proxy" 且置信度打折。
 * spec §10.3 要求代理因子在回测报告首页可被标红，标红的依据就是这里的 provenance
 * 与 confidence —— 少标一个，报告就会把代理误差当成真实结论展示。
 *
 * 与之相对，炸板率 / 封单强度 / 分时博弈 **代理还原不了**（需要分钟级或盘中快照）。
 * 这类因子的处理原则是：有真快照就读真快照并标 real，没有就 value = null + confidence 0。
 * 绝不用日线凑一个看起来合理的数 —— 假的 0 会被择时读成"今天没炸板，情绪很稳"。
 */
import type { FactorResult, FactorSpec, PointInTimeView } from "@/lib/contracts";
import {
  adjClose, barsUpTo, clamp, mean, pbool, pctChange, pnum, pstr, round6, evalDate
} from "@/lib/factors/util";
import {
  DEFAULT_LIMIT_THRESHOLDS, judgeBarLimitUp, limitDownCodes, limitUpCodes, proxyLbc,
} from "@/lib/factors/limit-up";

export interface Breadth {
  up: number; down: number; flat: number;
  limitUp: number; limitDown: number;
  /** 当日无日线或无前收的票。停牌与缺口都落在这里，不能算平盘 */
  unknown: number;
  limitUpCodes: string[]; limitDownCodes: string[];
  avgPct: number;
  total: number;
}

/**
 * 一次遍历同时算出涨跌家数与涨跌停家数。
 * 分两次遍历会把 5888 只票的日线拉两遍，回测里这是主要开销。
 */
export function marketBreadth(
  view: PointInTimeView, date: string, t = DEFAULT_LIMIT_THRESHOLDS
): Breadth {
  const b: Breadth = {
    up: 0, down: 0, flat: 0, limitUp: 0, limitDown: 0, unknown: 0,
    limitUpCodes: [], limitDownCodes: [], avgPct: 0, total: 0,
  };
  const pcts: number[] = [];
  const pull = 8 + (date === view.asOf ? 0 : view.tradingDays(date, view.asOf).length);

  for (const sec of view.universe()) {
    b.total++;
    const bars = barsUpTo(view, sec.code, date, 2, pull);
    const cur = bars.length > 0 ? bars[bars.length - 1] : null;
    if (cur === null || cur.date !== date) { b.unknown++; continue; }
    const prev = bars.length >= 2 ? bars[bars.length - 2] : null;
    const j = judgeBarLimitUp(sec, cur, prev, t);
    if (j.pct === null) { b.unknown++; continue; }

    pcts.push(j.pct);
    if (j.pct > 0) b.up++; else if (j.pct < 0) b.down++; else b.flat++;
    if (j.limitUp) { b.limitUp++; b.limitUpCodes.push(sec.code); }
    if (j.limitDown) { b.limitDown++; b.limitDownCodes.push(sec.code); }
  }
  b.avgPct = round6(mean(pcts));
  return b;
}

/** 昨日涨停股今日的平均涨幅 = 打板赚钱效应。有真快照优先用真快照的涨停名单 */
function ztFollowThrough(view: PointInTimeView, date: string): { avg: number | null; n: number; real: boolean } {
  const prevDay = view.prevTradingDay(date);
  if (prevDay === null) return { avg: null, n: 0, real: false };

  const real = view.ztPool(prevDay);
  const codes = real.length > 0 ? real.map(r => r.code) : limitUpCodes(view, prevDay).codes;
  if (codes.length === 0) return { avg: null, n: 0, real: real.length > 0 };

  const pcts: number[] = [];
  for (const code of codes) {
    const bars = barsUpTo(view, code, date, 2);
    if (bars.length < 2 || bars[bars.length - 1].date !== date) continue;
    pcts.push(pctChange(adjClose(bars[bars.length - 2]), adjClose(bars[bars.length - 1])));
  }
  return {
    avg: pcts.length === 0 ? null : round6(mean(pcts)),
    n: pcts.length, real: real.length > 0,
  };
}

/** 指数涨幅与距 MA20 的偏离。bar 不够 20 根时偏离为 null（不硬算短样本均线） */
function indexState(view: PointInTimeView, date: string, code: string) {
  const bars = barsUpTo(view, code, date, 21);
  const cur = bars.length > 0 ? bars[bars.length - 1] : null;
  if (cur === null || cur.date !== date || bars.length < 2) return { pct: null, ma20Dev: null };
  const pct = round6(pctChange(adjClose(bars[bars.length - 2]), adjClose(cur)));
  if (bars.length < 21) return { pct, ma20Dev: null };
  const ma20 = mean(bars.slice(bars.length - 20).map(adjClose));
  return { pct, ma20Dev: round6(pctChange(ma20, adjClose(cur))) };
}

const PROXY_CONF = 0.6;   // 日线代理的基准置信度。满 60 个交易日后由 §10.3 的相关性审计校准

/* ------------------------------ 盘面强度 ------------------------------ */

const 盘面强度: FactorSpec<number> = {
  name: "盘面强度", version: "1.0.0", group: "env",
  defaults: { 指数代码: "sh000001", 涨跌家数权重: 0.4, 指数权重: 0.3, 涨跌停权重: 0.3, 指数满档涨幅: 2, 涨停净家数满档: 30 },
  fn: ctx => {
    const date = evalDate(ctx.view, ctx.params);
    const b = marketBreadth(ctx.view, date);
    const idx = indexState(ctx.view, date, pstr(ctx.params, "指数代码", "sh000001"));

    const w1 = pnum(ctx.params, "涨跌家数权重", 0.4);
    const w2 = pnum(ctx.params, "指数权重", 0.3);
    const w3 = pnum(ctx.params, "涨跌停权重", 0.3);
    const idxFull = pnum(ctx.params, "指数满档涨幅", 2);
    const ztFull = pnum(ctx.params, "涨停净家数满档", 30);

    // 三个分项都归一化到 0~1：0.5 = 中性
    const denom = b.up + b.down + b.flat;
    const r1 = denom === 0 ? 0.5 : b.up / denom;
    const r2 = idx.pct === null ? 0.5 : clamp(0.5 + idx.pct / (idxFull * 2), 0, 1);
    const r3 = clamp(0.5 + (b.limitUp - b.limitDown) / (ztFull * 2), 0, 1);

    const wsum = w1 + w2 + w3;
    const value = round6(clamp(100 * (w1 * r1 + w2 * r2 + w3 * r3) / (wsum === 0 ? 1 : wsum), 0, 100));
    return {
      name: "盘面强度", version: "1.0.0", value,
      label: value >= 65 ? "强" : value >= 45 ? "中性" : "弱",
      provenance: "proxy",
      // 指数缺当日日线（盘中 22:00 前）时分项退化成中性，置信再降
      confidence: round6(PROXY_CONF * (idx.pct === null ? 0.7 : 1) * (b.total === 0 ? 0 : 1)),
      inputs: {
        日期: date, 上涨: b.up, 下跌: b.down, 平盘: b.flat, 无数据: b.unknown,
        涨停: b.limitUp, 跌停: b.limitDown, 指数涨幅: idx.pct, 指数距MA20: idx.ma20Dev, 平均涨幅: b.avgPct,
      },
    };
  },
};

/* ------------------------------ 情绪温度 ------------------------------ */

const 情绪温度: FactorSpec<number> = {
  name: "情绪温度", version: "1.0.0", group: "env",
  defaults: { 涨停满档: 80, 连板满档: 6, 跌停满档: 30 },
  fn: ctx => {
    const date = evalDate(ctx.view, ctx.params);
    const b = marketBreadth(ctx.view, date);
    const zt = ctx.view.ztPool(date);
    const maxLbc = zt.length > 0
      ? zt.reduce((m, r) => Math.max(m, r.lbc ?? 0), 0)
      : b.limitUpCodes.reduce((m, c) => Math.max(m, proxyLbc(ctx.view, c, date)), 0);
    const follow = ztFollowThrough(ctx.view, date);

    // 四个分项各自 0~1，缺项直接从加权里剔掉并降置信 —— 缺项补 0.5 会把"不知道"伪装成"中性"
    const terms: Array<[number, number]> = [
      [0.35, clamp(b.limitUp / pnum(ctx.params, "涨停满档", 80), 0, 1)],
      [0.2, clamp(maxLbc / pnum(ctx.params, "连板满档", 6), 0, 1)],
      [0.2, 1 - clamp(b.limitDown / pnum(ctx.params, "跌停满档", 30), 0, 1)],
    ];
    if (follow.avg !== null) terms.push([0.25, clamp(0.5 + follow.avg / 10, 0, 1)]);

    const wsum = terms.reduce((a, [w]) => a + w, 0);
    const value = round6(clamp(100 * terms.reduce((a, [w, v]) => a + w * v, 0) / wsum, 0, 100));
    return {
      name: "情绪温度", version: "1.0.0", value,
      label: value >= 75 ? "过热" : value >= 55 ? "偏热" : value >= 35 ? "温和" : value >= 20 ? "低温" : "冰点",
      provenance: "proxy",
      confidence: round6(PROXY_CONF * (follow.avg === null ? 0.8 : 1)),
      inputs: {
        日期: date, 涨停家数: b.limitUp, 跌停家数: b.limitDown, 最高连板: maxLbc,
        昨涨停今日均涨幅: follow.avg, 昨涨停样本: follow.n, 用了真涨停池: follow.real,
      },
    };
  },
};

/* ------------------------------ 赚钱效应 ------------------------------ */

const 赚钱效应: FactorSpec<number> = {
  name: "赚钱效应", version: "1.0.0", group: "env",
  defaults: { 上涨占比权重: 0.5, 打板兑现权重: 0.5 },
  fn: ctx => {
    const date = evalDate(ctx.view, ctx.params);
    const b = marketBreadth(ctx.view, date);
    const follow = ztFollowThrough(ctx.view, date);

    const denom = b.up + b.down + b.flat;
    const upRatio = denom === 0 ? 0.5 : b.up / denom;
    const w1 = pnum(ctx.params, "上涨占比权重", 0.5);
    const w2 = pnum(ctx.params, "打板兑现权重", 0.5);

    // 昨日没有涨停股时打板分项无从谈起，只用上涨占比，并把置信度降下来
    const value = follow.avg === null
      ? round6(clamp(100 * upRatio, 0, 100))
      : round6(clamp(100 * (w1 * upRatio + w2 * clamp(0.5 + follow.avg / 10, 0, 1)) / (w1 + w2), 0, 100));

    return {
      name: "赚钱效应", version: "1.0.0", value,
      label: value >= 60 ? "赚钱" : value >= 40 ? "分化" : "亏钱",
      provenance: "proxy",
      confidence: round6(PROXY_CONF * (follow.avg === null ? 0.7 : 1)),
      inputs: {
        日期: date, 上涨占比: round6(upRatio), 昨涨停今日均涨幅: follow.avg,
        昨涨停样本: follow.n, 上涨: b.up, 下跌: b.down,
      },
    };
  },
};

/* ---------------------------- 涨停 / 跌停家数 ---------------------------- */

const 涨停家数: FactorSpec<number> = {
  name: "涨停家数", version: "1.0.0", group: "env",
  defaults: {},
  fn: ctx => {
    const date = evalDate(ctx.view, ctx.params);
    const r = limitUpCodes(ctx.view, date);
    const zt = ctx.view.ztPool(date);
    return {
      name: "涨停家数", version: "1.0.0", value: r.codes.length,
      label: `${r.codes.length}家`,
      // 有真快照时仍然返回代理值：两者口径不同（真快照含 ST 与新股的交易所口径），
      // 混用会让同一因子在有/无快照的日期之间跳变，回测曲线出现人造断层。
      // 真值差异交给 §10.3 的相关性审计去量化。
      provenance: "proxy", confidence: PROXY_CONF,
      inputs: { 日期: date, 代码: r.codes, 无数据票数: r.unknown.length, 真快照家数: zt.length > 0 ? zt.length : null },
    };
  },
};

const 跌停家数: FactorSpec<number> = {
  name: "跌停家数", version: "1.0.0", group: "env",
  defaults: {},
  fn: ctx => {
    const date = evalDate(ctx.view, ctx.params);
    const r = limitDownCodes(ctx.view, date);
    const dt = ctx.view.dtPool(date);
    return {
      name: "跌停家数", version: "1.0.0", value: r.codes.length,
      label: `${r.codes.length}家`,
      provenance: "proxy", confidence: PROXY_CONF,
      inputs: { 日期: date, 代码: r.codes, 真快照家数: dt.length > 0 ? dt.length : null },
    };
  },
};

/* ------------------------------ 连板高度 ------------------------------ */

const 连板高度: FactorSpec<number> = {
  name: "连板高度", version: "1.0.0", group: "env",
  // 强制代理：spec §10.3 的 proxy-vs-real 相关性审计要在**有真快照的日期上**
  // 拿到代理值才能算 ρ。没有这个开关，审计只能拿到真值，ρ 无从计算。
  defaults: { 回溯上限: 15, 强制代理: false },
  fn: ctx => {
    const date = evalDate(ctx.view, ctx.params);
    const zt = pbool(ctx.params, "强制代理", false) ? [] : ctx.view.ztPool(date);

    if (zt.length > 0) {
      const best = [...zt].sort((a, b) => (b.lbc ?? 0) - (a.lbc ?? 0) || (a.code < b.code ? -1 : 1))[0];
      return {
        name: "连板高度", version: "1.0.0", value: best.lbc ?? 0,
        label: `${best.lbc ?? 0}板`,
        provenance: "real", confidence: 0.95,
        inputs: { 日期: date, 最高板龙头: best.code, 涨停家数: zt.length },
      };
    }

    // 无真快照 → 日线代理。代理数不出"开板后重新封板"这类情形，所以置信度明显更低
    const maxBack = pnum(ctx.params, "回溯上限", 15);
    const codes = limitUpCodes(ctx.view, date).codes;
    const pairs = codes.map(c => [c, proxyLbc(ctx.view, c, date, maxBack)] as const);
    const best = pairs.reduce<readonly [string, number]>(
      (m, p) => (p[1] > m[1] || (p[1] === m[1] && p[0] < m[0]) ? p : m), ["", 0]);
    return {
      name: "连板高度", version: "1.0.0", value: best[1],
      label: `${best[1]}板`,
      provenance: "proxy", confidence: round6(PROXY_CONF * 0.8),
      inputs: { 日期: date, 最高板龙头: best[0] === "" ? null : best[0], 涨停家数: codes.length },
    };
  },
};

/* --------------------- 代理还原不了的：只读真快照 --------------------- */

/**
 * 炸板率 = 有过开板的涨停票 / 涨停票总数。
 *
 * 日线里没有"盘中开过板"的信息（一根日线只有四个价），所以这个因子只能来自
 * zt_pool.open_times 这样的盘中快照。快照不存在的历史日期一律 null + confidence 0。
 */
const 炸板率: FactorSpec<number | null> = {
  name: "炸板率", version: "1.0.0", group: "env",
  defaults: {},
  fn: ctx => {
    const date = evalDate(ctx.view, ctx.params);
    const zt = ctx.view.ztPool(date);
    if (zt.length === 0) return missing("炸板率", date, "无涨停池真快照，日线不可还原炸板");
    const opened = zt.filter(z => (z.openTimes ?? 0) > 0).length;
    return {
      name: "炸板率", version: "1.0.0", value: round6(opened / zt.length),
      label: `${opened}/${zt.length}`,
      provenance: "real", confidence: 0.95,
      inputs: { 日期: date, 炸板票数: opened, 涨停票数: zt.length },
    };
  },
};

/** 封单额同理：日线看不见买一挂了多少钱 */
const 封单强度: FactorSpec<number | null> = {
  name: "封单强度", version: "1.0.0", group: "env",
  defaults: {},
  fn: ctx => {
    const date = evalDate(ctx.view, ctx.params);
    const zt = ctx.view.ztPool(date).filter(z => Number.isFinite(z.sealAmt));
    if (zt.length === 0) return missing("封单强度", date, "无涨停池真快照，日线不可还原封单额");
    const avg = round6(mean(zt.map(z => z.sealAmt)));
    return {
      name: "封单强度", version: "1.0.0", value: avg,
      label: `均封单 ${Math.round(avg / 1e8 * 100) / 100} 亿`,
      provenance: "real", confidence: 0.95,
      inputs: { 日期: date, 样本: zt.length, 最大封单: Math.max(...zt.map(z => z.sealAmt)) },
    };
  },
};

/** 缺真快照时的统一返回：null + 0 置信，绝不返回 0 值 */
function missing(name: string, date: string, why: string): FactorResult<number | null> {
  return {
    name, version: "1.0.0", value: null, label: why,
    provenance: "real", confidence: 0, inputs: { 日期: date, 缺失原因: why },
  };
}

export const ENV_FACTORS: FactorSpec<any>[] = [
  盘面强度, 情绪温度, 赚钱效应, 涨停家数, 跌停家数, 连板高度, 炸板率, 封单强度,
];
