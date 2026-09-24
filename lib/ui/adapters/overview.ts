import type Database from "better-sqlite3";
import type { Candidate, StrategyConfig } from "@/lib/contracts/strategy";
import type { FactorResult } from "@/lib/contracts/factor";
import { unavailable, type Avail } from "@/lib/ui/derive";
import { createSqliteView } from "@/lib/pit/sqlite-view";
import { defaultRegistry } from "@/lib/factors";
import { makeRunner, resolveDate } from "@/lib/strategy/engine";
import { structureTarget } from "@/lib/strategy/v2/slots/structure-pricing";
import { variantReports, type VariantReport } from "@/lib/shadow/report";
import { switchStatus, type SwitchStatus } from "@/lib/shadow/switch";

/**
 * 作战台的"盘面语境"：情绪阶段、候选的参考目标位、影子盘。
 *
 * 这三样都不改变正式策略的结论，只是让人看得见：
 *   - 情绪阶段对所有人都一样，不管正式策略用不用五段状态机择时
 *   - 正式组合不带定价时，按结构位定价槽的同一套公式补"参考"目标位与盈亏比，并标明是参考
 *   - 影子盘成绩与待批提案
 */

type Db = Database.Database;

export interface StageView {
  /** 冰点 / 启动 / 发酵 / 高潮 / 退潮；判不出来时为 null，label 说原因 */
  stage: string | null;
  label: string;
  /** 综合热度相对自身历史的分位 [0,1] */
  heat: number | null;
  days: number | null;
  confidence: number;
  /** 判定用的交易日（最后一个有情绪行的收盘日） */
  date: string;
  factor: FactorResult<unknown>;
}

const STAGES = new Set(["冰点", "启动", "发酵", "高潮", "退潮"]);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

export function cycleStage(db: Db, asOf: string, config: StrategyConfig): Avail<StageView> {
  try {
    const view = createSqliteView(db, asOf);
    // 与引擎同一个评估日：盘中当天的情绪行要夜里才建，拿今天去判只会得到"未构建"
    const date = resolveDate(view);
    const r = makeRunner(defaultRegistry, config, view, date, () => {}).run("情绪阶段");
    if (r === null) return unavailable("情绪阶段因子未注册");
    const stage = typeof r.label === "string" && STAGES.has(r.label) ? r.label : null;
    const inputs = (r.inputs ?? {}) as Record<string, unknown>;
    return {
      available: true,
      stage, label: r.label ?? "—", heat: num(r.value), days: num(inputs["持续天数"]),
      confidence: r.confidence, date: String(inputs["日期"] ?? date).slice(0, 10), factor: r,
    };
  } catch (e) {
    return unavailable(`情绪阶段判定失败：${(e as Error).message}`);
  }
}

export interface PricingRef {
  targetPx: number | null;
  rrRatio: number | null;
  source: string;
  /** true = 正式组合自己给的；false = 界面按结构位定价公式补的参考值，没有参与选股 */
  formal: boolean;
}

/** 每只候选的目标位与盈亏比。正式组合给了就用它的，没给就按同一套公式补参考值 */
export function pricingRefs(db: Db, asOf: string, config: StrategyConfig, rows: Candidate[]): Map<string, PricingRef> {
  const out = new Map<string, PricingRef>();
  const need = rows.filter(c => typeof c.targetPx !== "number" && c.triggerPx !== null);
  for (const c of rows) {
    if (typeof c.targetPx === "number") out.set(c.code, { targetPx: c.targetPx, rrRatio: c.rrRatio ?? null, source: "正式组合", formal: true });
  }
  if (need.length === 0) return out;
  try {
    const view = createSqliteView(db, asOf);
    const run = makeRunner(defaultRegistry, config, view, resolveDate(view), () => {});
    for (const c of need) {
      const s = run.run("结构位", { code: c.code }), a = run.run("ATR", { code: c.code });
      const t = structureTarget(c.triggerPx as number, c.stopPx, num(s?.inputs?.["阻力"]), num(a?.inputs?.["ATR"]));
      out.set(c.code, t === null
        ? { targetPx: null, rrRatio: null, source: "算不出（无结构位也无 ATR）", formal: false }
        : { targetPx: t.target, rrRatio: t.rr, source: t.source, formal: false });
    }
  } catch {
    // 参考值算不出来不影响候选本身，列里显示破折号
  }
  return out;
}

export interface ShadowView {
  live: VariantReport[];
  replay: VariantReport[];
  status: SwitchStatus | null;
  statusError: string | null;
}

export function shadowOverview(db: Db): Avail<ShadowView> {
  try {
    let status: SwitchStatus | null = null, statusError: string | null = null;
    try { status = switchStatus(db as any); } catch (e) { statusError = (e as Error).message; }
    return { available: true, live: variantReports(db as any, "live"), replay: variantReports(db as any, "replay"), status, statusError };
  } catch (e) {
    return unavailable(`影子盘读取失败：${(e as Error).message}`, "多半是还没跑过迁移（shadow_* / strategy_switch 表不存在）");
  }
}
