import type Database from "better-sqlite3";
import type { FactorResult } from "@/lib/contracts";
import type { StrategyConfig, TechHint } from "@/lib/contracts/strategy";
import { unavailable, type Avail } from "@/lib/ui/derive";
import { createSqliteView } from "@/lib/pit/sqlite-view";
import { baseAdjFactor } from "@/lib/factors/util";
import { defaultRegistry } from "@/lib/factors";
import { makeRunner, resolveDate } from "@/lib/strategy/engine";
import { latestQuotes, securities, watchpool } from "@/lib/ui/queries";
import { todaySignalCard } from "@/lib/ui/adapters/engines";

/**
 * 单票按需分析：趋势读数 + 买卖点。
 *
 * 存在的理由：作战台一次渲染就把候选、持仓、观察池全算一遍，池子大了要几秒
 * （实测点完"加入观察池"刷新要 2.2~8.1 秒）。而多数时候人只想看**一只**：
 * 自选里某只票到什么位置了、还能不能买。所以这里做成按代码取一份，点谁算谁。
 *
 * 三条不能越的线：
 *   1. **不另算一套信号**。所有读数都跑因子层（makeRunner 走正式注册表与 YAML 的
 *      `因子参数`），与作战台、回测、影子盘同源。在前端随手写一条"我觉得要涨"
 *      会被当成系统给的信号 —— 那是这套系统最容易亏钱的用法。
 *   2. **买不买由引擎说了算**。触发价 / 止损 / 目标来自评估器（与今日候选同一套筛），
 *      这里只是把它取出来摆在一起，不做二次裁决。
 *   3. **区分事实与判断**。因子读数是事实（带日期与根数）；"多头 / 偏空"这类
 *      综合结论是**规则判定**，规则写在下面 `trendVerdict` 里，界面必须标出来。
 */

type Db = Database.Database;

/** 一个因子的读数。原样带上 label / inputs，界面照抄，不在这里翻译成结论 */
export interface Readout {
  key: string;
  name: string;
  label: string | null;
  value: number | null;
  confidence: number;
  /** 因子自己给的中间量（DIF/DEA、阻力、支撑、RSI…）。取值走 num()，拿出来就用 */
  inputs: Record<string, unknown>;
}

export type TrendVerdict = "多头" | "偏多" | "震荡" | "偏空" | "空头" | "数据不足";

export interface TrendRead {
  verdict: TrendVerdict;
  /** 判定所依据的分数与规则原文：结论必须能被复核，不能只给一个词 */
  score: number;
  rule: string;
  /** 参与打分的三个读数，取不到就是 null（样本不足 / 停牌滞后都算） */
  basis: { maDir: number | null; daily: string | null; weekly: string | null };
  readouts: Readout[];
  levels: { support: number | null; resistance: number | null; atr: number | null; price: number | null };
  pattern: { kind: string; state: string; neckline: number | null } | null;
  /** 最后一个交易日（因子求值的时点），不是今天 */
  date: string;
  /** 近 60 根日线收盘（前复权，与 K 线图同一口径），给迷你走势用 */
  spark: Array<{ date: string; c: number }>;
}

export interface PlanRead {
  /** 引擎给的结论：可买（到触发价）/ 暂不买 / 不买 / 今日候选 / 持仓动作 */
  action: string;
  triggerPx: number | null;
  stopPx: number | null;
  targetPx: number | null;
  rrRatio: number | null;
  /** true = 目标价与盈亏比是结构位定价公式补的参考值，正式评估器没给 */
  targetRef: boolean;
  mainline: string | null;
  reasons: string[];
  hints: TechHint[];
  /** 今日档位：防守档下"可买"也不该买，这条必须跟着结论一起出现 */
  gear: string | null;
  /** 现价距触发价（负数 = 已经跌破触发价） */
  distanceRatio: number | null;
}

export interface StockAnalysis {
  code: string;
  name: string | null;
  asOf: string;
  price: number | null;
  pct: number | null;
  quoteTs: string | null;
  trend: TrendRead;
  /** 引擎不可用时为 null，理由写在 planReason 里 —— 不能让策略配置挡住趋势读数 */
  plan: PlanRead | null;
  planReason: string | null;
  /** 我在观察池里手填的那套（没加过自选就是 null） */
  mine: { triggerPx: number | null; stopPx: number | null; thesis: string | null; addedAt: string | null } | null;
  note: string;
}

const MACD_SCORE: Record<string, number> = { 金叉: 2, 多头: 1, 空头: -1, 死叉: -2 };

const VERDICT_RULE =
  "均线方向(−2~2) + 日线MACD(±1/±2) + 周线MACD(±1/±2) 三项相加：≥4 多头 / 2~3 偏多 / −1~1 震荡 / −2~−3 偏空 / ≤−4 空头。这是规则判定，不是预测";

/**
 * 三个趋势读数合成一个词。
 *
 * 抽成纯函数是因为它是**判断**：改一个阈值就等于换了一套说法，必须能单测、
 * 也必须让别人看清自己被哪个规则判成了空头。分数制而不是一串 if，是因为
 * "周线死叉但均线还多头"这种互相打架的情况需要有个明确去处（落在震荡），
 * 写成 if 链就会取决于谁先写。
 */
export function trendVerdict(
  maDir: number | null,
  daily: string | null,
  weekly: string | null,
): { verdict: TrendVerdict; score: number; rule: string } {
  const sMa = typeof maDir === "number" && Number.isFinite(maDir) ? Math.max(-2, Math.min(2, maDir)) : null;
  const sD = daily === null ? null : MACD_SCORE[daily] ?? 0;
  const sW = weekly === null ? null : MACD_SCORE[weekly] ?? 0;
  if (sMa === null && sD === null && sW === null) {
    return { verdict: "数据不足", score: 0, rule: VERDICT_RULE };
  }
  const score = (sMa ?? 0) + (sD ?? 0) + (sW ?? 0);
  const verdict: TrendVerdict =
    score >= 4 ? "多头" : score >= 2 ? "偏多" : score >= -1 ? "震荡" : score >= -3 ? "偏空" : "空头";
  return { verdict, score, rule: VERDICT_RULE };
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** 置信度为 0 的读数当没有：样本不足、停牌滞后，都不是"中性" */
function readout(key: string, f: FactorResult<any> | null): Readout | null {
  if (f === null || f.confidence === 0) return null;
  return { key, name: f.name, label: f.label ?? null, value: num(f.value), confidence: f.confidence, inputs: (f.inputs ?? {}) as Record<string, unknown> };
}

/**
 * 单票分析。
 *
 * 分两段是刻意的：趋势只要日线 + 因子，几十毫秒；买卖点要跑一遍全市场引擎
 * （与作战台必须同源，否则同一只票会出现两套触发价）。所以引擎挂了只丢后半段，
 * 前半段照常返回 —— 不能因为 YAML 写错就让人连趋势都看不了。
 */
export function stockAnalysis(db: Db, code: string, asOf: string, config: StrategyConfig): Avail<StockAnalysis> {
  try {
    const view = createSqliteView(db, asOf);
    const date = resolveDate(view);
    // 迷你走势取前复权收盘，基准用序列最大值而不是最后一根（最后一根被写成 1.0 时
    // 整段会按真实价的若干倍显示，见 baseAdjFactor 的说明）—— 与 K 线图同一口径
    const hfq = view.adjBars(code, 120);
    const f = baseAdjFactor(hfq);
    const spark = f > 0
      ? hfq.slice(-60).map(b => ({ date: b.date, c: Math.round((b.c / f) * 1e4) / 1e4 }))
      : [];
    const run = makeRunner(defaultRegistry, config, view, date, () => {});
    const r = (name: string, key: string) => readout(key, run.run(name, { code }));

    const daily = r("日线MACD", "daily");
    const weekly = r("周线MACD", "weekly");
    const ma = r("均线方向", "ma");
    const vol = r("量能", "volume");
    const boll = r("布林位置", "boll");
    const os = r("超买超卖", "osc");
    const st = r("结构位", "structure");
    const pt = r("M顶W底", "pattern");
    const at = r("ATR", "atr");

    const readouts = [ma, daily, weekly, vol, boll, os, st, pt, at].filter((x): x is Readout => x !== null);

    // 均线方向的 label 是"多头排列/反弹未确认/反抽未破位/空头排列"，value 才是 −2~2 的分数
    const maDir = ma === null ? null : num(ma.value);
    const v = trendVerdict(maDir, daily?.label ?? null, weekly?.label ?? null);

    const si = st?.inputs ?? {};
    const pi = pt?.inputs ?? {};
    const patternKind = typeof pi["形态"] === "string" ? (pi["形态"] as string) : null;

    const trend: TrendRead = {
      verdict: v.verdict, score: v.score, rule: v.rule,
      basis: { maDir, daily: daily?.label ?? null, weekly: weekly?.label ?? null },
      readouts,
      levels: {
        support: num(si["支撑"]), resistance: num(si["阻力"]),
        atr: num((at?.inputs ?? {})["ATR"]), price: num(si["现价"]),
      },
      pattern: patternKind === null || patternKind === "无"
        ? null
        : { kind: patternKind, state: typeof pi["状态"] === "string" ? (pi["状态"] as string) : "", neckline: num(pi["颈线"]) },
      date,
      spark,
    };

    // ── 买卖点：与作战台同源，取同一张信号卡里这只票的那一条 ──
    let plan: PlanRead | null = null;
    let planReason: string | null = null;
    const card = todaySignalCard(db, asOf, config, { advice: true });
    if (!card.available) {
      planReason = card.reason;
    } else {
      // 观察 > 持仓 > 候选：同一只票可能同时是候选又在池里，引擎只出"观察"那一条，
      // 这里的优先级只是防止将来多出一条时取错
      const advice = card.card.advice ?? [];
      const a = advice.find(x => x.code === code && x.kind === "观察")
        ?? advice.find(x => x.code === code && x.kind === "持仓")
        ?? advice.find(x => x.code === code);
      if (a === undefined) {
        // 今天根本没算到它（不在池里、不是持仓、也不是候选）—— 不是故障，如实说
        planReason = "引擎今天没有这只票的判定：它不在观察池、不是持仓，也不在今日候选里";
      } else {
        plan = {
          action: a.action, triggerPx: a.triggerPx, stopPx: a.stopPx, targetPx: a.targetPx,
          rrRatio: a.rrRatio, targetRef: a.targetRef, mainline: a.mainline,
          reasons: a.reasons, hints: a.tech.hints, gear: card.card.env.gear ?? null,
          distanceRatio: null,
        };
      }
    }

    const q = latestQuotes(db, [code]).get(code) ?? null;
    if (plan !== null && q !== null && plan.triggerPx !== null && plan.triggerPx > 0) {
      plan.distanceRatio = (q.price - plan.triggerPx) / plan.triggerPx;
    }
    // 现价优先取快照：结构位里的"现价"是它求值那一日的收盘价，可能已经隔了几天
    if (trend.levels.price === null) trend.levels.price = q?.price ?? null;

    const mine = watchpool(db, true).find(x => x.code === code) ?? null;

    return {
      available: true,
      code,
      name: securities(db, [code]).get(code)?.name ?? null,
      asOf,
      price: q?.price ?? null,
      pct: typeof q?.pct === "number" ? q.pct : null,
      quoteTs: q?.ts ?? null,
      trend,
      plan,
      planReason,
      mine: mine === null
        ? null
        : { triggerPx: mine.triggerPx, stopPx: mine.stopPx, thesis: mine.thesis, addedAt: mine.addedAt },
      note: "读数是因子层在最后一个交易日的求值（日期已标出）；买卖点是引擎今日判定，与作战台同一套筛。都不是预测",
    };
  } catch (e) {
    return unavailable(`单票分析失败：${(e as Error).message}`);
  }
}
