import type { Db } from "@/lib/db";
import type { Action, ErrorType, Outcome, Prediction, Verdict } from "@/lib/contracts";
import { dateOf, EVAL_HORIZONS, round, type EvalHorizon, type LedgerFilter } from "@/lib/ledger/query";
import { listPendingPredictions } from "@/lib/ledger/record";

/**
 * 到期对账（spec §11 第 2 步）。
 *
 * 唯一的硬规矩：拿不到真价就不结算。
 * 价源顺序 kline_daily → quote_snapshot，两个都没有就留 pending 并报出来。
 * 悄悄猜一个价会污染整个台账，而台账是这套闭环里唯一必须可信的东西 ——
 * 胜率、错误频次、参数建议全部长在它上面，一次伪造就让后面所有数字失去意义。
 */

export type PriceSource = "kline_daily" | "quote_snapshot";

export type Direction = "看涨" | "看跌" | "中性";

/** 未能结算的原因，闭枚举，方便 job 统计与告警 */
export type SkipReason = "日历不足" | "无基准价" | "无收盘价";

/**
 * 方向映射。
 * 持有 归到看涨：不动仓位等于赌逻辑还在，跌下去就是判错。
 * 观察 没有方向承诺，一律中性，不进胜率分母。
 */
export function directionOf(action: Action): Direction {
  switch (action) {
    case "买入": case "加仓": case "持有": return "看涨";
    case "减仓": case "清仓": return "看跌";
    default: return "中性";
  }
}

/**
 * 中性带：带内不算对也不算错。
 *
 * 取 1.5% × sqrt(horizon) —— 波动随时间开根号放大，用固定阈值会让 D1 太松、D30 太紧。
 * 数值不是市场规律，是一条可调的判定线；改它会同时改变历史胜率，所以别当作"调优"。
 */
export const NEUTRAL_BAND_PCT: Record<EvalHorizon, number> = {
  1: 1.5, 5: 3.4, 10: 4.7, 20: 6.7, 30: 8.2,
};

export function verdictOf(dir: Direction, actualPct: number, bandPct: number): Verdict {
  if (dir === "中性") return "中性";
  const favorable = dir === "看涨" ? actualPct : -actualPct;
  if (favorable >= bandPct) return "命中";
  if (favorable <= -bandPct) return "偏差";
  return "中性";
}

/** 日历上 base 之后的第 n 个交易日；日历没排到就返回 null，绝不用自然日兜 */
export function tradingDayOffset(db: Db, base: string, n: number): string | null {
  const row = db.prepare(
    `SELECT date FROM trading_calendar WHERE is_open = 1 AND date > ?
     ORDER BY date LIMIT 1 OFFSET ?`
  ).get(base, n - 1) as { date: string } | undefined;
  return row?.date ?? null;
}

function tradingDayOnOrBefore(db: Db, date: string): string | null {
  const row = db.prepare(
    `SELECT date FROM trading_calendar WHERE is_open = 1 AND date <= ?
     ORDER BY date DESC LIMIT 1`
  ).get(date) as { date: string } | undefined;
  return row?.date ?? null;
}

/**
 * 基准日 = 做判断时「已经收盘、能真看到」的最后一个交易日。
 *
 * 盘后的判断用当日收盘；盘前/盘中的判断当日还没收盘，拿当日收盘当基准
 * 就是把未来价当成了决策价，会系统性地把胜率算高。
 * 这也让 D1 与龙虎榜 d1_chg 的口径一致：上榜日为基准，次日为 D1。
 */
export function baseTradingDay(db: Db, p: Prediction): string | null {
  const d = dateOf(p.ts);
  if (p.phase === "盘后") return tradingDayOnOrBefore(db, d);
  const prev = db.prepare(
    `SELECT date FROM trading_calendar WHERE is_open = 1 AND date < ?
     ORDER BY date DESC LIMIT 1`
  ).get(d) as { date: string } | undefined;
  return prev?.date ?? null;
}

export interface ResolvedPx {
  px: number;
  source: PriceSource;
  date: string;
}

/**
 * 某个交易日的收盘价。
 *
 * 日线优先；日线还没落库（当日盘后 job 之前）时退回当日最后一笔快照。
 * 快照只认同一天的：拿前一天的快照顶上等于偷偷改了 horizon。
 *
 * 收盘价乘 adj_factor：M0 阶段该列恒为 1.0（新浪日线不复权，见 collectors/daily），
 * 乘上去当前无影响，将来填的是累计复权因子时口径才对得上。
 */
export function resolvePx(db: Db, code: string, date: string): ResolvedPx | null {
  const bar = db.prepare(
    `SELECT c, COALESCE(adj_factor, 1.0) f FROM kline_daily WHERE code = ? AND date = ?`
  ).get(code, date) as { c: number | null; f: number } | undefined;
  if (bar && bar.c != null) return { px: bar.c * bar.f, source: "kline_daily", date };

  // quote_snapshot.ts 存的是 UTC ISO 串。交易时段（北京 09:30–15:00 = UTC 01:30–07:00）
  // 与盘后 job 都落在同一个 UTC 日期上，所以按前 10 位匹配是安全的；
  // 只有北京时间 08:00 前写入的快照会落到前一个 UTC 日期，而那时段没有采集。
  const snap = db.prepare(
    `SELECT price FROM quote_snapshot WHERE code = ? AND substr(ts,1,10) = ? AND price IS NOT NULL
     ORDER BY ts DESC LIMIT 1`
  ).get(code, date) as { price: number } | undefined;
  if (snap) return { px: snap.price, source: "quote_snapshot", date };

  return null;
}

/**
 * 龙虎榜自带的 D1/D5/D10/D20/D30 后续涨跌幅，用作交叉校验的天然监督标签。
 *
 * 只做校验不做结算依据：这些列上榜当日全为 NULL、随时间回填（见 003 迁移与 jobs.LHB_LABEL_OFFSETS），
 * 拿它当结算值会让同一条预测在不同时间跑出不同结果，破坏幂等。
 * 同一票同日可能有多条上榜原因，取任意一条非 NULL 即可（同票同日的后续涨幅相同）。
 */
export function lhbLabelPct(db: Db, code: string, date: string, horizon: EvalHorizon): number | null {
  if (!EVAL_HORIZONS.includes(horizon)) return null;
  const col = `d${horizon}_chg`;
  const row = db.prepare(
    `SELECT ${col} v FROM lhb WHERE code = ? AND date = ? AND ${col} IS NOT NULL LIMIT 1`
  ).get(code, date) as { v: number } | undefined;
  return row?.v ?? null;
}

export interface SettleFacts {
  base: ResolvedPx;
  exit: ResolvedPx;
  horizonEnd: string;
  actualPct: number;
  direction: Direction;
  bandPct: number;
  /** horizon 区间内最低价是否破过止损（含破位当日） */
  stopBreached: boolean;
  stopBreachDate: string | null;
  /** 龙虎榜标签交叉校验值，NULL 很正常（未回填 / 没上榜） */
  lhbLabelPct: number | null;
}

export interface SettleAttempt {
  predId: string;
  code: string;
  ok: boolean;
  facts?: SettleFacts;
  outcome?: Outcome;
  reason?: SkipReason;
  detail?: string;
}

export interface ReconcileOptions {
  /** 对账基准日，默认取上海当日 */
  asOf?: string;
  /** 结算时间戳，测试用固定值 */
  now?: string;
  bands?: Partial<Record<EvalHorizon, number>>;
  /** 可选的错因归因钩子。不传就只落对账事实，错因留 null 等后续 attributeOutcome 补 */
  attribute?: (p: Prediction, facts: SettleFacts, verdict: Verdict)
    => { errorType: ErrorType | null; attribution: string } | null;
  filter?: LedgerFilter;
  limit?: number;
}

function shanghaiToday(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());
}

/** 算一条的结算结果，不写库。reconcile 与归因都复用它，保证口径一致 */
export function settleOne(db: Db, p: Prediction, opts: ReconcileOptions = {}): SettleAttempt {
  const head = { predId: p.id, code: p.code };
  const base = baseTradingDay(db, p);
  if (!base) {
    return { ...head, ok: false, reason: "日历不足", detail: `${dateOf(p.ts)} 之前没有交易日记录` };
  }
  const horizonEnd = tradingDayOffset(db, base, p.evalHorizon);
  if (!horizonEnd) {
    return { ...head, ok: false, reason: "日历不足", detail: `${base} 之后不足 ${p.evalHorizon} 个交易日` };
  }

  const basePx = resolvePx(db, p.code, base);
  if (!basePx) return { ...head, ok: false, reason: "无基准价", detail: `${base} 无日线也无快照` };
  const exitPx = resolvePx(db, p.code, horizonEnd);
  if (!exitPx) return { ...head, ok: false, reason: "无收盘价", detail: `${horizonEnd} 无日线也无快照` };

  const actualPct = round(((exitPx.px - basePx.px) / basePx.px) * 100, 6);
  const direction = directionOf(p.action);
  const bandPct = opts.bands?.[p.evalHorizon] ?? NEUTRAL_BAND_PCT[p.evalHorizon];
  const verdict = verdictOf(direction, actualPct, bandPct);

  // 破止损：看区间内最低价，不看收盘 —— 盘中破位就已经触发纪律
  let stopBreached = false, stopBreachDate: string | null = null;
  if (p.stopPx != null) {
    const row = db.prepare(
      `SELECT date FROM kline_daily WHERE code = ? AND date > ? AND date <= ?
         AND l IS NOT NULL AND l <= ? ORDER BY date LIMIT 1`
    ).get(p.code, base, horizonEnd, p.stopPx) as { date: string } | undefined;
    if (row) { stopBreached = true; stopBreachDate = row.date; }
  }

  const label = lhbLabelPct(db, p.code, base, p.evalHorizon);
  const facts: SettleFacts = {
    base: basePx, exit: exitPx, horizonEnd, actualPct, direction, bandPct,
    stopBreached, stopBreachDate, lhbLabelPct: label,
  };

  const sign = actualPct >= 0 ? "+" : "";
  let attribution =
    `D${p.evalHorizon} ${base} ${basePx.px}(${basePx.source}) → ${horizonEnd} ${exitPx.px}(${exitPx.source})` +
    ` = ${sign}${actualPct.toFixed(2)}%，${direction}／中性带 ±${bandPct}% → ${verdict}`;
  if (label != null && Math.abs(label - actualPct) > 2) {
    // 背离通常意味着复权/停牌，报出来让人看，不自动改判
    attribution += `；⚠与龙虎榜 d${p.evalHorizon}_chg ${label.toFixed(2)}% 背离`;
  }
  if (stopBreached) attribution += `；${stopBreachDate} 破止损 ${p.stopPx}`;

  const extra = opts.attribute?.(p, facts, verdict) ?? null;
  const outcome: Outcome = {
    predId: p.id,
    verdict,
    actualPct,
    errorType: extra?.errorType ?? null,
    attribution: extra ? `${attribution}｜${extra.attribution}` : attribution,
    settledAt: opts.now ?? new Date().toISOString(),
  };
  return { ...head, ok: true, facts, outcome };
}

export interface ReconcileReport {
  asOf: string;
  /** 本次扫到的到期未结算条数 */
  scanned: number;
  settled: Outcome[];
  /** 拿不到价 / 日历不够，留着下次再来。必须报出来，不能沉默 */
  skipped: SettleAttempt[];
}

/**
 * 结算入口。幂等：已结算的预测不会再被扫到（LEFT JOIN outcome 已排除），
 * 写入再加 ON CONFLICT DO NOTHING 兜第二层 —— 并发跑两次也不会改掉已落地的判定。
 */
export function reconcile(db: Db, opts: ReconcileOptions = {}): ReconcileReport {
  const asOf = opts.asOf ?? shanghaiToday();
  const pending = listPendingPredictions(db, asOf, opts.filter ?? {}, opts.limit);

  const settled: Outcome[] = [];
  const skipped: SettleAttempt[] = [];
  const stmt = db.prepare(
    `INSERT INTO outcome (pred_id, verdict, actual_pct, error_type, attribution, settled_at)
     VALUES (?,?,?,?,?,?) ON CONFLICT(pred_id) DO NOTHING`
  );

  for (const p of pending) {
    const att = settleOne(db, p, opts);
    if (!att.ok || !att.outcome) { skipped.push(att); continue; }
    const o = att.outcome;
    const info = stmt.run(o.predId, o.verdict, o.actualPct, o.errorType, o.attribution, o.settledAt);
    if (info.changes > 0) settled.push(o);
  }
  return { asOf, scanned: pending.length, settled, skipped };
}
