import type Database from "better-sqlite3";
import type { SignalCard, TechHint } from "@/lib/contracts/strategy";
import type { PricingRef } from "@/lib/ui/adapters/overview";
import { latestQuotes, dailyBars } from "@/lib/ui/queries";

/**
 * 作战台右栏自选列表 + 中间决策卡的数据：候选、持仓、观察池三组，每只一行。
 *
 * 全是引擎已经给出的结论的**重新排列**，不在这里做任何判断 ——
 * 动作、价位、理由都来自信号卡（candidates / advice），这里只补现价与迷你走势。
 * 结果要能序列化：它会整个交给客户端组件，点哪只看哪只不再回服务端。
 */

type Db = Database.Database;

export type ItemGroup = "候选" | "持仓" | "观察";
export type ActionTone = "buy" | "sell" | "hold" | "wait" | "no";

export interface CockpitItem {
  key: string;
  code: string;
  name: string | null;
  group: ItemGroup;
  action: string;
  tone: ActionTone;
  account: string | null;
  triggerPx: number | null;
  stopPx: number | null;
  targetPx: number | null;
  /** true = 目标价是按结构位定价公式补的参考值，正式组合没用它选股 */
  targetRef: boolean;
  targetSource: string | null;
  rrRatio: number | null;
  size: number | null;
  score: number | null;
  mainline: string | null;
  thesis: string;
  reasons: string[];
  hints: TechHint[];
  /** 持仓的技术面倾向（参考） */
  lean: string | null;
  daily: string | null;
  weekly: string | null;
  resistance: number | null;
  support: number | null;
  filters: string[];
  lowConf: string[];
  price: number | null;
  /** 今日涨跌幅，百分数（-2.37 = -2.37%） */
  pct: number | null;
  quoteTs: string | null;
  spark: number[];
}

function toneOf(action: string): ActionTone {
  if (action === "买入" || action === "加仓" || action === "今日候选" || action.startsWith("可买")) return "buy";
  if (action === "清仓" || action === "减仓") return "sell";
  if (action === "持有") return "hold";
  if (action === "不买") return "no";
  return "wait";
}

const SPARK_N = 30;

export function cockpitItems(db: Db, card: SignalCard, pricing: Map<string, PricingRef> | undefined): CockpitItem[] {
  const advice = card.advice ?? [];
  const techOf = new Map(advice.filter(a => a.kind === "候选").map(a => [a.code, a.tech]));
  const items: CockpitItem[] = [];

  for (const c of card.candidates) {
    const p = pricing?.get(c.code);
    const t = techOf.get(c.code);
    items.push({
      key: `候选:${c.account}:${c.code}`, code: c.code, name: c.name ?? null, group: "候选",
      action: c.action, tone: toneOf(c.action), account: c.account,
      triggerPx: c.triggerPx, stopPx: c.stopPx,
      targetPx: p?.targetPx ?? null, targetRef: p ? !p.formal : false, targetSource: p?.source ?? null,
      rrRatio: p?.rrRatio ?? null, size: c.size, score: c.score, mainline: null,
      thesis: c.thesis, reasons: [], hints: t?.hints ?? [], lean: null,
      daily: t?.daily ?? null, weekly: t?.weekly ?? null, resistance: t?.resistance ?? null, support: t?.support ?? null,
      filters: c.passedFilters, lowConf: c.factors.filter(f => f.confidence < 0.8).map(f => f.name),
      price: null, pct: null, quoteTs: null, spark: [],
    });
  }
  const candCodes = new Set(card.candidates.map(c => c.code));
  for (const a of advice) {
    if (a.kind === "候选") continue;               // 候选已经在上面按信号卡原样列过
    // 观察池里的票今天也是候选：只在候选组出现一次，免得同一只票两套说法
    if (a.kind === "观察" && candCodes.has(a.code)) continue;
    items.push({
      key: `${a.kind}:${a.code}`, code: a.code, name: a.name, group: a.kind,
      action: a.action, tone: toneOf(a.action), account: null,
      triggerPx: a.triggerPx, stopPx: a.stopPx, targetPx: a.targetPx, targetRef: a.targetRef, targetSource: null,
      rrRatio: a.rrRatio, size: null, score: null, mainline: a.mainline,
      thesis: a.kind === "持仓" ? a.reasons.join("；") : "", reasons: a.kind === "观察" ? a.reasons : [],
      hints: a.tech.hints, lean: a.lean,
      daily: a.tech.daily, weekly: a.tech.weekly, resistance: a.tech.resistance, support: a.tech.support,
      filters: [], lowConf: [], price: null, pct: null, quoteTs: null, spark: [],
    });
  }

  const quotes = latestQuotes(db, [...new Set(items.map(i => i.code))]);
  const spark = new Map<string, number[]>();
  for (const it of items) {
    const q = quotes.get(it.code);
    if (q) { it.price = q.price; it.pct = typeof q.pct === "number" ? q.pct : null; it.quoteTs = q.ts; }
    if (!spark.has(it.code)) spark.set(it.code, dailyBars(db, it.code, SPARK_N).map(b => b.c));
    it.spark = spark.get(it.code)!;
    if (it.price === null && it.spark.length > 0) it.price = it.spark[it.spark.length - 1];
  }
  return items;
}
