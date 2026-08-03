import type { AccountType, Phase, Prediction } from "@/lib/contracts";

/**
 * 台账查询的公共部分：过滤条件与行映射。
 *
 * 诚实定义（spec §11）：这一层不是模型自训练，是规则库 + 参数随实盘对账进化。
 * 它唯一必须守住的性质是「可信」—— 统计口径在 winrate / dashboard / suggest
 * 三处必须完全一致，否则同一批数据出三个胜率，谁也没法用它做决策。
 * 所以口径集中放这里，不许各模块各写一遍 WHERE。
 */

/** 契约里 evalHorizon 是内联字面量联合，没有具名类型，这里派生一个给内部用 */
export type EvalHorizon = Prediction["evalHorizon"];

export const EVAL_HORIZONS: EvalHorizon[] = [1, 5, 10, 20, 30];

export const PHASES: Phase[] = ["盘前", "盘中", "盘后"];

export interface LedgerFilter {
  /** 预测日期下界（含），按 prediction.ts 的日期部分比 */
  from?: string;
  /** 预测日期上界（含） */
  to?: string;
  code?: string;
  strategyId?: string;
  account?: AccountType;
  phase?: Phase;
  horizon?: EvalHorizon;
  /** 只看 Advisor 改过 / 没改过的那一臂 */
  advisorInfluenced?: boolean;
}

/**
 * 拼 prediction 表上的过滤条件。返回的 sql 片段一律以 " AND " 开头，调用方接在
 * 自己的 WHERE 后面即可 —— 不返回完整 WHERE，避免调用方还要判断有没有条件。
 */
export function predWhere(f: LedgerFilter = {}, alias = "p"): { sql: string; params: unknown[] } {
  const parts: string[] = [];
  const params: unknown[] = [];
  // ts 是 ISO 串（可能带 +08:00 偏移），按前 10 位当交易日比较；这与
  // dashboard 的分组口径一致，不做时区换算 —— 预测本来就是按本地交易日记的
  if (f.from) { parts.push(`substr(${alias}.ts,1,10) >= ?`); params.push(f.from); }
  if (f.to) { parts.push(`substr(${alias}.ts,1,10) <= ?`); params.push(f.to); }
  if (f.code) { parts.push(`${alias}.code = ?`); params.push(f.code); }
  if (f.strategyId) { parts.push(`${alias}.strategy_id = ?`); params.push(f.strategyId); }
  if (f.account) { parts.push(`${alias}.account = ?`); params.push(f.account); }
  if (f.phase) { parts.push(`${alias}.phase = ?`); params.push(f.phase); }
  if (f.horizon) { parts.push(`${alias}.eval_horizon = ?`); params.push(f.horizon); }
  if (f.advisorInfluenced !== undefined) {
    parts.push(`${alias}.advisor_influenced = ?`);
    params.push(f.advisorInfluenced ? 1 : 0);
  }
  return { sql: parts.length ? ` AND ${parts.join(" AND ")}` : "", params };
}

export interface PredictionRow {
  id: string; ts: string; phase: string; code: string; strategy_id: string;
  action: string; account: string | null; trigger_px: number | null; stop_px: number | null;
  size: number | null; thesis: string | null; gear: string | null;
  eval_horizon: number; valid_until: string; advisor_influenced: number;
}

export const PRED_COLS =
  `p.id, p.ts, p.phase, p.code, p.strategy_id, p.action, p.account, p.trigger_px,
   p.stop_px, p.size, p.thesis, p.gear, p.eval_horizon, p.valid_until, p.advisor_influenced`;

/**
 * 行 → 契约。
 *
 * 注意 004 迁移里 account/gear/size/thesis 允许 NULL，而契约要求非空。
 * 读路径不替它们编默认值（编了就等于伪造台账），只做类型断言原样透出；
 * 校验放在写路径（record.ts）—— 从这里进的行保证是完整的。
 */
export function toPrediction(r: PredictionRow): Prediction {
  return {
    id: r.id,
    ts: r.ts,
    phase: r.phase as Prediction["phase"],
    code: r.code,
    strategyId: r.strategy_id,
    action: r.action as Prediction["action"],
    account: r.account as Prediction["account"],
    triggerPx: r.trigger_px,
    stopPx: r.stop_px,
    size: r.size as number,
    thesis: r.thesis as string,
    gear: r.gear as Prediction["gear"],
    evalHorizon: r.eval_horizon as EvalHorizon,
    validUntil: r.valid_until,
    advisorInfluenced: r.advisor_influenced === 1,
  };
}

/** ISO 串取交易日部分 */
export function dateOf(ts: string): string {
  return ts.slice(0, 10);
}

export function round(x: number, digits = 4): number {
  const f = 10 ** digits;
  return Math.round(x * f) / f;
}
