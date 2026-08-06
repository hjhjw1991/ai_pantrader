import type { Db } from "@/lib/db";
import type { Prediction } from "@/lib/contracts";
import { snapshotForPrediction } from "@/lib/ledger/strategy-snapshot";
import { EVAL_HORIZONS, PRED_COLS, predWhere, toPrediction, type EvalHorizon, type LedgerFilter, type PredictionRow } from "@/lib/ledger/query";

/**
 * 信号落台账（spec §11 第 1 步）。
 *
 * 引擎每出一条信号就写一行，含 eval_horizon 与 valid_until —— 事后才补记的预测
 * 等于事后选样本，胜率会自动变好看，那整套闭环就没有意义了。
 *
 * 台账只追加，不改写：同 id 同内容视为重复投递（job 重跑很正常），
 * 同 id 不同内容直接报错。允许改写的台账不再是台账。
 */

export class LedgerConflictError extends Error {
  constructor(readonly predId: string, readonly diff: string) {
    super(`prediction ${predId} 已存在且内容不同，台账不允许改写：${diff}`);
    this.name = "LedgerConflictError";
  }
}

/**
 * 写入前校验。
 *
 * advisorInfluenced 必须是真布尔值：A/B 量化 Claude 的边际贡献（spec §5.3）
 * 完全靠这个字段分组，undefined 被静默当成 false 会把「有 Claude 参与」的样本
 * 混进对照组，得出的差值是假的 —— 这比缺数据更糟，因为看不出来。
 */
function assertPrediction(p: Prediction): void {
  if (typeof p.advisorInfluenced !== "boolean") {
    throw new Error(
      `prediction ${p.id}: advisorInfluenced 必须显式给 true/false（收到 ${typeof p.advisorInfluenced}）`
    );
  }
  if (!EVAL_HORIZONS.includes(p.evalHorizon)) {
    throw new Error(
      `prediction ${p.id}: evalHorizon 只能是 ${EVAL_HORIZONS.join("/")}（对齐龙虎榜 D1..D30 标签），收到 ${p.evalHorizon}`
    );
  }
  for (const k of ["id", "ts", "code", "strategyId", "action", "phase", "validUntil"] as const) {
    if (!p[k]) throw new Error(`prediction ${p.id}: ${k} 不能为空`);
  }
  if (p.validUntil < p.ts.slice(0, 10)) {
    throw new Error(`prediction ${p.id}: validUntil ${p.validUntil} 早于预测日 ${p.ts.slice(0, 10)}`);
  }
}

/** 只比参与身份的字段，settled 之类的派生信息不参与 */
function fingerprint(p: Prediction): string {
  return JSON.stringify([
    p.ts, p.phase, p.code, p.strategyId, p.action, p.account, p.triggerPx, p.stopPx,
    p.size, p.thesis, p.gear, p.evalHorizon, p.validUntil, p.advisorInfluenced,
  ]);
}

/**
 * 快照当前策略原文。细节见 lib/ledger/strategy-snapshot.ts ——
 * 那一刻正是台账开始依赖这套参数的时刻。
 *
 * 失败绝不能拖垮台账写入：预测本身不可再生（事后补记等于事后选样本），
 * 而快照随时可以补。所以吞异常，只在 stderr 留声。
 */
function snapshotIfNeeded(db: Db, strategyId: string): void {
  try {
    snapshotForPrediction(db, strategyId);
  } catch (e) {
    console.error(`[台账] 策略快照失败（不影响预测写入）：${(e as Error).message}`);
  }
}

export function recordPrediction(db: Db, p: Prediction): void {
  assertPrediction(p);
  snapshotIfNeeded(db, p.strategyId);

  const existing = getPrediction(db, p.id);
  if (existing) {
    const a = fingerprint(existing), b = fingerprint(p);
    if (a === b) return;              // job 重跑，幂等
    throw new LedgerConflictError(p.id, `${a} != ${b}`);
  }

  db.prepare(
    `INSERT INTO prediction (id, ts, phase, code, strategy_id, action, account, trigger_px,
       stop_px, size, thesis, gear, eval_horizon, valid_until, advisor_influenced)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(p.id, p.ts, p.phase, p.code, p.strategyId, p.action, p.account, p.triggerPx,
        p.stopPx, p.size, p.thesis, p.gear, p.evalHorizon, p.validUntil,
        p.advisorInfluenced ? 1 : 0);
}

/** 整卡信号一起落库：一条非法就整批回滚，避免半张信号卡进台账 */
export function recordPredictions(db: Db, ps: Prediction[]): number {
  db.transaction(() => { for (const p of ps) recordPrediction(db, p); })();
  return ps.length;
}

export function getPrediction(db: Db, id: string): Prediction | null {
  const row = db.prepare(
    `SELECT ${PRED_COLS} FROM prediction p WHERE p.id = ?`
  ).get(id) as PredictionRow | undefined;
  return row ? toPrediction(row) : null;
}

/** 到期且还没结算的预测，reconcile 的输入 */
export function listPendingPredictions(
  db: Db, asOf: string, filter: LedgerFilter = {}, limit?: number
): Prediction[] {
  const w = predWhere(filter);
  const rows = db.prepare(
    `SELECT ${PRED_COLS} FROM prediction p
     LEFT JOIN outcome o ON o.pred_id = p.id
     WHERE o.pred_id IS NULL AND p.valid_until <= ?${w.sql}
     ORDER BY p.valid_until, p.id${limit ? " LIMIT " + Number(limit) : ""}`
  ).all(asOf, ...w.params) as PredictionRow[];
  return rows.map(toPrediction);
}

export interface ValidUntil {
  date: string;
  /** 交易日 = 日历里数出来的；估算 = 日历还没排到那天，只能按自然日推 */
  basis: "交易日" | "估算";
}

/**
 * 给引擎算 valid_until。
 *
 * 日历是由指数日线生成的（见 lib/data/calendar），只覆盖到今天，
 * 所以 D20/D30 的末日在下单当天往往还不存在 —— 这时给估算值。
 *
 * 估算不会污染收益：valid_until 只决定「什么时候去尝试对账」，
 * 真实区间由 reconcile 在结算时用当时的日历重新数（见 reconcile.tradingDayOffset），
 * 日历不够长就干脆不结算。所以这里宁可估早了多试几次，也不能编出个末日来算收益。
 */
export function estimateValidUntil(db: Db, fromDate: string, horizon: EvalHorizon): ValidUntil {
  const row = db.prepare(
    `SELECT date FROM trading_calendar WHERE is_open = 1 AND date > ?
     ORDER BY date LIMIT 1 OFFSET ?`
  ).get(fromDate, horizon - 1) as { date: string } | undefined;
  if (row) return { date: row.date, basis: "交易日" };

  // 一周 5 个交易日，再加 3 天缓冲盖掉长假；宁可晚一点去对账，也不要早到没数据
  const calDays = Math.ceil((horizon * 7) / 5) + 3;
  const date = new Date(Date.parse(`${fromDate}T00:00:00Z`) + calDays * 86400_000)
    .toISOString().slice(0, 10);
  return { date, basis: "估算" };
}
