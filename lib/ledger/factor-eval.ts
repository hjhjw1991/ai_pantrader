import type { Db } from "@/lib/db";
import type { Phase } from "@/lib/contracts";
import type { EvalHorizon } from "@/lib/ledger/query";
import { baseTradingDay, resolvePx, tradingDayOffset } from "@/lib/ledger/reconcile";

/**
 * 因子评估（P4）：IC + 分组检验。
 *
 * 为什么要有它：engine.ts 的打分是 5 个手拍的常数权重（lbc .30 / sealAmt .20 /
 * 均线方向 .20 / 量能 .15 / 龙虎榜净买 .15），从来没有被数据校准过。
 * 没有这套评估，调权重就是拍脑袋 —— 而拍脑袋调出来的权重在样本外必然更差。
 *
 * ── 三条方法论边界，都是从公开实践里挑出来、并针对 A 股改过的 ──────────────
 *
 * 1. **样本不按"成交"筛选**。只在"买点够到、真成交了"的样本上算 IC 会引入
 *    选择偏差：能成交这件事本身就和后续涨跌相关（回踩到位 vs 一路不回头），
 *    于是你量到的不是因子的预测力，而是"回踩"这个条件的预测力。
 *    这里的目标值是**这只票自己的前瞻收益**（基准日→horizon 末），
 *    与成没成交无关 —— 因子问的是"这个读数能不能预言涨跌"，这是个独立的真问题。
 *
 * 2. **IC 在横截面内算，再在时间上聚合**。把不同日期的样本混在一起算一个相关系数，
 *    量到的大半是"那天大盘涨不涨"，不是因子的选股能力。正确做法：每天内部算一次
 *    因子值与当日各票收益的秩相关，再对这一串 IC 取均值/标准差。
 *
 * 3. **IC 好看不等于能用**。IC 是全样本的秩相关，头尾两组可能完全不单调：
 *    因子值最高的那一组（真正会去买的那一段）均值可能接近 0，而 IC 照样是正的。
 *    所以必须配分组检验，并且**只看多头那一段** —— A 股不能做空，
 *    空头那一段的收益是无法兑现的，把它算进"策略期望"是自欺。
 *    这里用 headEdge（最高一组均值 − 全样本均值）直接暴露"头部失效"。
 *
 * 判读阈值沿用 alphalens 的通行口径：IC > 0.05 可用、> 0.10 优秀、IR > 0.5、|t| > 2 显著。
 */

export type FactorScope = "stock" | "env";

/** 横截面至少几只票才肯算 IC。2 只的秩相关恒为 ±1，是纯噪声 */
export const MIN_CROSS_SECTION = 3;
/** 全样本至少多少条才肯下"可用"以上的结论 */
export const MIN_OBS = 30;

export interface FactorObs {
  predId: string;
  /** 决策日，横截面的分组键 */
  date: string;
  code: string;
  action: string;
  horizon: EvalHorizon;
  /** 因子读数。定性因子的 value 是 NULL，进不了评估（见 loadFactorObs） */
  value: number;
  /** 该票基准日→horizon 末的涨跌幅（%），**未**做方向翻转：因子预测的是股价本身 */
  fwdPct: number;
}

export interface FactorEvalFilter {
  from?: string;
  to?: string;
  /** 只取某个 horizon。不传就全取，但横截面按 (日期, horizon) 分组，不跨 horizon 混 */
  horizon?: EvalHorizon;
}

/**
 * 取某个因子的全部可评估观测。
 *
 * 排除：value 为 NULL（定性因子，硬转数字就是伪造）、作废、脏数据。
 * 前瞻收益用 reconcile 同一套取价（resolvePx + baseTradingDay + tradingDayOffset），
 * 口径只有一份 —— 另写一套取价，因子评估的结论就和账本对不上。
 */
export function loadFactorObs(
  db: Db, factorName: string, scope: FactorScope, opts: FactorEvalFilter = {}
): FactorObs[] {
  const where: string[] = [
    "f.factor_name = ?", "f.scope = ?", "f.value IS NOT NULL",
    "o.verdict != '作废'", "o.dirty_reason IS NULL",
  ];
  const params: Array<string | number> = [factorName, scope];
  if (opts.from) { where.push("substr(p.ts,1,10) >= ?"); params.push(opts.from); }
  if (opts.to) { where.push("substr(p.ts,1,10) <= ?"); params.push(opts.to); }
  if (opts.horizon) { where.push("p.eval_horizon = ?"); params.push(opts.horizon); }

  const rows = db.prepare(
    `SELECT p.id, p.ts, p.phase, p.code, p.action, p.eval_horizon h, f.value v
     FROM prediction p
       JOIN prediction_factor f ON f.pred_id = p.id
       JOIN outcome o ON o.pred_id = p.id
     WHERE ${where.join(" AND ")}
     ORDER BY p.ts, p.code`
  ).all(...params) as Array<{
    id: string; ts: string; phase: Phase; code: string; action: string; h: EvalHorizon; v: number;
  }>;

  const out: FactorObs[] = [];
  for (const r of rows) {
    const base = baseTradingDay(db, { ts: r.ts, phase: r.phase });
    if (base === null) continue;
    const end = tradingDayOffset(db, base, r.h);
    if (end === null) continue;
    const b = resolvePx(db, r.code, base);
    const e = resolvePx(db, r.code, end);
    if (!b || !e || b.px <= 0) continue;
    out.push({
      predId: r.id, date: r.ts.slice(0, 10), code: r.code, action: r.action,
      horizon: r.h, value: r.v, fwdPct: ((e.px - b.px) / b.px) * 100,
    });
  }
  return out;
}

/* ------------------------------ 秩相关基元 ------------------------------ */

/** 平均秩（并列取平均），1-based */
export function ranks(xs: number[]): number[] {
  const idx = xs.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v);
  const out = new Array<number>(xs.length).fill(0);
  let k = 0;
  while (k < idx.length) {
    let j = k;
    while (j + 1 < idx.length && idx[j + 1].v === idx[k].v) j++;
    const avg = (k + j) / 2 + 1;
    for (let t = k; t <= j; t++) out[idx[t].i] = avg;
    k = j + 1;
  }
  return out;
}

export function pearson(xs: number[], ys: number[]): number | null {
  const n = xs.length;
  if (n < 3) return null;
  let mx = 0, my = 0;
  for (let i = 0; i < n; i++) { mx += xs[i]; my += ys[i]; }
  mx /= n; my /= n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) {
    const a = xs[i] - mx, b = ys[i] - my;
    sxy += a * b; sxx += a * a; syy += b * b;
  }
  // 全并列（sxx=0）时相关系数无定义 —— 返回 null，绝不返回 0 冒充"无关"
  if (sxx === 0 || syy === 0) return null;
  return sxy / Math.sqrt(sxx * syy);
}

/** Spearman 秩相关 = 对秩做 Pearson。因子值有大量并列（评级档位），必须用平均秩 */
export function spearman(xs: number[], ys: number[]): number | null {
  if (xs.length !== ys.length) return null;
  return pearson(ranks(xs), ranks(ys));
}

/* -------------------------------- IC -------------------------------- */

export type FactorVerdict = "样本不足" | "显著" | "可用" | "弱" | "不可用";

export interface FactorIc {
  factorName: string;
  scope: FactorScope;
  /** 有效横截面数。env 因子是时间序列，这里是有效日期数 */
  nCross: number;
  nObs: number;
  icMean: number | null;
  icStd: number | null;
  /** IR = icMean / icStd。衡量 IC 的稳定性，比 IC 均值更能预测实盘能不能用 */
  ir: number | null;
  tStat: number | null;
  verdict: FactorVerdict;
}

function stdOf(xs: number[]): number | null {
  if (xs.length < 2) return null;
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  const v = xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1);
  return Math.sqrt(v);
}

function verdictOf(icMean: number, tStat: number | null, nObs: number): FactorVerdict {
  if (nObs < MIN_OBS) return "样本不足";
  const a = Math.abs(icMean);
  if (tStat !== null && Math.abs(tStat) >= 2 && a >= 0.05) return "显著";
  if (a >= 0.05) return "可用";
  if (a >= 0.02) return "弱";
  return "不可用";
}

/**
 * 横截面 IC：每个 (日期, horizon) 内部算一次秩相关，再在时间上聚合。
 *
 * 按 (日期, horizon) 分组而不是只按日期：D1 和 D20 的收益不是同一件事，
 * 混在一个横截面里等于拿两把尺子量同一个数。
 */
export function crossSectionIc(obs: FactorObs[]): { ics: number[]; nObs: number } {
  const byKey = new Map<string, FactorObs[]>();
  for (const o of obs) {
    const k = `${o.date}|${o.horizon}`;
    const arr = byKey.get(k);
    if (arr) arr.push(o); else byKey.set(k, [o]);
  }
  const ics: number[] = [];
  let nObs = 0;
  for (const arr of byKey.values()) {
    if (arr.length < MIN_CROSS_SECTION) continue;
    const ic = spearman(arr.map((o) => o.value), arr.map((o) => o.fwdPct));
    if (ic === null) continue;
    ics.push(ic);
    nObs += arr.length;
  }
  return { ics, nObs };
}

/**
 * 环境因子的 IC：环境因子一天只有一个值，横截面内全是并列，秩相关无定义。
 * 只能走时间序列 —— 每天取一个点（环境读数 vs 当天所有票的平均前瞻收益），
 * 再在这些点上算相关。这量的是"大盘环境读数能不能预言当天这批票的整体表现"。
 */
export function envTimeSeriesIc(obs: FactorObs[]): { ics: number[]; nObs: number } {
  const byDate = new Map<string, FactorObs[]>();
  for (const o of obs) {
    const arr = byDate.get(o.date);
    if (arr) arr.push(o); else byDate.set(o.date, [o]);
  }
  const xs: number[] = [], ys: number[] = [];
  let nObs = 0;
  for (const arr of byDate.values()) {
    // 同一天同一个环境因子读数相同，取首个即可
    const v = arr[0].value;
    const mean = arr.reduce((a, b) => a + b.fwdPct, 0) / arr.length;
    xs.push(v);
    ys.push(mean);
    nObs += arr.length;
  }
  // 时间序列上只有一个点也算不出来；至少 3 天
  const ic = pearson(xs, ys);
  return { ics: ic === null ? [] : [ic], nObs };
}

export function evalFactorIc(
  db: Db, factorName: string, scope: FactorScope, opts: FactorEvalFilter = {}
): FactorIc {
  const obs = loadFactorObs(db, factorName, scope, opts);
  const { ics, nObs } = scope === "env" ? envTimeSeriesIc(obs) : crossSectionIc(obs);
  const nCross = ics.length;
  if (nCross === 0) {
    return {
      factorName, scope, nCross: 0, nObs: 0,
      icMean: null, icStd: null, ir: null, tStat: null, verdict: "样本不足",
    };
  }
  const icMean = ics.reduce((a, b) => a + b, 0) / nCross;
  const icStd = stdOf(ics);
  const ir = icStd !== null && icStd > 0 ? icMean / icStd : null;
  const tStat = icStd !== null && icStd > 0 ? icMean / (icStd / Math.sqrt(nCross)) : null;
  return {
    factorName, scope, nCross, nObs, icMean, icStd, ir, tStat,
    verdict: verdictOf(icMean, tStat, nObs),
  };
}

/* ------------------------------ 分组检验 ------------------------------ */

export interface QuantileGroup {
  /** 1 = 因子值最低的一组，G = 最高的一组 */
  g: number;
  n: number;
  meanFwdPct: number;
}

export interface FactorQuantiles {
  factorName: string;
  groups: QuantileGroup[];
  /** 最高一组的均值。A 股不能做空，这是**唯一能兑现**的那一段 */
  headMeanPct: number | null;
  /** 全样本均值，作为比较基准 */
  baseMeanPct: number | null;
  /**
   * headMean − baseMean。IC 为正但这个值接近 0 或为负 = 头部失效：
   * 因子全靠"排除差的"贡献相关，真按它挑出来买的那一组并没有超额。
   */
  headEdgePct: number | null;
  /** 单调性：组序号与组均值的秩相关。接近 ±1 才是真的单调分层 */
  monotonicity: number | null;
}

/**
 * 分组检验。分组键是**组内日期归一化后的秩**，不是原始值的绝对分位 ——
 * 不然某个因子值整体大的日期会整批落进最高组，量到的就又是"那天怎样"了。
 */
export function evalFactorQuantiles(
  db: Db, factorName: string, scope: FactorScope, opts: FactorEvalFilter & { groups?: number } = {}
): FactorQuantiles {
  const G = Math.max(2, opts.groups ?? 5);
  const obs = scope === "env" ? [] : loadFactorObs(db, factorName, scope, opts);
  const buckets: number[][] = Array.from({ length: G }, () => []);

  const byKey = new Map<string, FactorObs[]>();
  for (const o of obs) {
    const k = `${o.date}|${o.horizon}`;
    const arr = byKey.get(k);
    if (arr) arr.push(o); else byKey.set(k, [o]);
  }
  for (const arr of byKey.values()) {
    if (arr.length < 2) continue;              // 单只票没有"组内排序"可言
    const rk = ranks(arr.map((o) => o.value));
    for (let i = 0; i < arr.length; i++) {
      const norm = (rk[i] - 1) / (arr.length - 1);          // 0..1
      const g = Math.min(G, Math.floor(norm * G) + 1);
      buckets[g - 1].push(arr[i].fwdPct);
    }
  }

  const groups: QuantileGroup[] = buckets.map((xs, i) => ({
    g: i + 1,
    n: xs.length,
    meanFwdPct: xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : Number.NaN,
  }));
  const nonEmpty = groups.filter((x) => x.n > 0);
  const all = buckets.flat();
  const baseMean = all.length ? all.reduce((a, b) => a + b, 0) / all.length : null;
  const head = groups[G - 1].n > 0 ? groups[G - 1].meanFwdPct : null;
  const monotonicity = nonEmpty.length >= 3
    ? spearman(nonEmpty.map((x) => x.g), nonEmpty.map((x) => x.meanFwdPct))
    : null;

  return {
    factorName,
    // 空组返回 NaN 而不是 0：0 会被读成"这组收益为零"，NaN 才是"这组没有样本"
    groups: groups.map((x) => ({ ...x, meanFwdPct: x.n > 0 ? x.meanFwdPct : Number.NaN })),
    headMeanPct: head,
    baseMeanPct: baseMean,
    headEdgePct: head !== null && baseMean !== null ? head - baseMean : null,
    monotonicity,
  };
}
