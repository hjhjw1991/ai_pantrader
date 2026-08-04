import type Database from "better-sqlite3";
import type {
  DailyBar,
  DtRow,
  LhbRow,
  LhbSeatRow,
  Quote,
  SecurityRow,
  SectorRankRow,
  ZtRow,
  Board,
} from "@/lib/contracts/pit";
import type { AccountType } from "@/lib/contracts/strategy";
import type { Position } from "@/lib/contracts/execution";
import type { Outcome, Prediction, Verdict, ErrorType } from "@/lib/contracts/ledger";
import type { Phase, Action, EnvGear } from "@/lib/contracts/strategy";

/**
 * 前端的 DB 读层。所有页面只经过这里读库。
 *
 * 三条规矩：
 *  1. 全部预编译参数化，任何用户输入都不进 SQL 字符串（IN 子句只按长度生成占位符）。
 *  2. 返回契约类型（lib/contracts），不把 snake_case 行对象漏给页面 ——
 *     否则契约一改，散落在 6 个页面里的字段名要改 6 遍。
 *  3. 表为空返回空数组，**不造任何默认行**。空是空态，由页面说明为什么空。
 */

type Db = Database.Database;

/** IN 子句的占位符。只用数组长度，值一律走绑定参数 */
function placeholders(n: number): string {
  return new Array(n).fill("?").join(",");
}

/**
 * 时间戳列归一到上海挂钟，**在 SQL 里做**。
 *
 * 为什么必须做：库里两种口径并存（migration 006 之后是挂钟串，之前是 UTC ISO）。
 * 直接 `MAX(ts)` 是字符串比较，而 'T'(0x54) > ' '(0x20) ——
 * 一条 8 月 1 日的 ISO 行会"大于"8 月 3 日的挂钟行，于是"最新快照"取成了老行。
 * 这个错误恰好会让界面显示一个更旧的时间，看起来只是告警多了一次，
 * 但同样的比较也用在 ROW_NUMBER 的排序上 —— 那会让某只票的现价取成几天前的价。
 *
 * 放在 SQL 里而不是捞回 JS 再排：全市场 5888 只票的快照表，
 * 全捞回来再切会把盘中刷新拖成秒级。
 */
function wall(col: string): string {
  return `(CASE WHEN ${col} LIKE '%Z'
                THEN strftime('%Y-%m-%d %H:%M:%f', ${col}, '+8 hours')
                ELSE REPLACE(${col}, 'T', ' ') END)`;
}

// ═══════════════════════════ 元数据 / 健康 ═══════════════════════════

export interface TableCount {
  table: string;
  rows: number;
}

/** 设置页与空态用：哪张表真的有数据。空态文案要能指出缺的是哪一张 */
const COUNTED_TABLES = [
  "security", "trading_calendar", "kline_daily", "kline_min", "quote_snapshot",
  "zt_pool", "dt_pool", "sector_rank", "lhb", "lhb_seat", "macro",
  "data_gap", "source_health",
  "strategy", "watchpool", "prediction", "outcome", "advisor_output",
  "account", "position", "trade", "ord",
] as const;

export function tableCounts(db: Db): TableCount[] {
  const out: TableCount[] = [];
  for (const t of COUNTED_TABLES) {
    try {
      // 表名来自上面的常量白名单，不是用户输入
      const r = db.prepare(`SELECT COUNT(*) AS n FROM "${t}"`).get() as { n: number };
      out.push({ table: t, rows: r.n });
    } catch {
      out.push({ table: t, rows: -1 }); // -1 = 表不存在（migration 未跑）
    }
  }
  return out;
}

export function getMetaValue(db: Db, key: string): string | null {
  try {
    const r = db.prepare("SELECT value FROM app_meta WHERE key = ?").get(key) as
      | { value: string }
      | undefined;
    return r?.value ?? null;
  } catch {
    return null;
  }
}

export interface GapRow {
  date: string;
  source: string;
  kind: string;
  reason: string | null;
  recoverable: boolean;
  detectedAt: string | null;
  resolvedAt: string | null;
}

/**
 * 未解决的数据缺口。
 *
 * recoverable=0 的行是**永久损失**：分钟线/涨停池/板块榜没有历史接口，
 * 缺一天就永远缺一天（spec §18.2）。这类行必须顶到主页面，不能收进详情抽屉。
 */
export function unresolvedGaps(db: Db, limit = 500): GapRow[] {
  const rows = db
    .prepare(
      `SELECT date, source, kind, reason, recoverable, detected_at, resolved_at
       FROM data_gap WHERE resolved_at IS NULL
       ORDER BY recoverable ASC, date DESC LIMIT ?`
    )
    .all(limit) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    date: r.date as string,
    source: r.source as string,
    kind: r.kind as string,
    reason: (r.reason as string) ?? null,
    recoverable: Number(r.recoverable) === 1,
    detectedAt: (r.detected_at as string) ?? null,
    resolvedAt: (r.resolved_at as string) ?? null,
  }));
}

export interface SourceHealthRow {
  source: string;
  lastTs: string;
  lastOk: boolean;
  lastLatencyMs: number | null;
  lastErr: string | null;
  /** 最近窗口内的请求数与成功数 */
  windowN: number;
  windowOk: number;
  /** 成功率；窗口内无样本时为 null，不是 0 */
  okRate: number | null;
  avgLatencyMs: number | null;
}

export function sourceHealth(db: Db, sinceIso: string): SourceHealthRow[] {
  const rows = db
    .prepare(
      `WITH ranked AS (
         SELECT source, ${wall("ts")} AS ts, ok, latency_ms, err,
                ROW_NUMBER() OVER (PARTITION BY source ORDER BY ${wall("ts")} DESC) AS rn
         FROM source_health
       )
       SELECT r.source, r.ts, r.ok, r.latency_ms, r.err,
              (SELECT COUNT(*) FROM source_health s
                WHERE s.source = r.source AND ${wall("s.ts")} >= ?) AS n_win,
              (SELECT COALESCE(SUM(s.ok), 0) FROM source_health s
                WHERE s.source = r.source AND ${wall("s.ts")} >= ?) AS ok_win,
              (SELECT AVG(s.latency_ms) FROM source_health s
                WHERE s.source = r.source AND ${wall("s.ts")} >= ? AND s.ok = 1) AS lat_win
       FROM ranked r WHERE r.rn = 1 ORDER BY r.source`
    )
    .all(sinceIso, sinceIso, sinceIso) as Array<Record<string, unknown>>;

  return rows.map((r) => {
    const n = Number(r.n_win);
    const ok = Number(r.ok_win);
    return {
      source: r.source as string,
      lastTs: r.ts as string,
      lastOk: Number(r.ok) === 1,
      lastLatencyMs: r.latency_ms === null ? null : Number(r.latency_ms),
      lastErr: (r.err as string) ?? null,
      windowN: n,
      windowOk: ok,
      okRate: n > 0 ? ok / n : null,
      avgLatencyMs: r.lat_win === null ? null : Number(r.lat_win),
    };
  });
}

// ═══════════════════════════ 行情 ═══════════════════════════

/** 快照最新时点。页面顶栏必须显示它 —— 用户要知道自己看的是几点的价 */
export function latestQuoteTs(db: Db): string | null {
  const r = db
    .prepare(`SELECT MAX(${wall("ts")}) AS m FROM quote_snapshot`)
    .get() as { m: string | null };
  return r.m ?? null;
}

/** 逐票最新快照。无快照的票不出现在结果里，调用方按 null 处理，不要补 0 价 */
export function latestQuotes(db: Db, codes: string[]): Map<string, Quote> {
  const m = new Map<string, Quote>();
  if (codes.length === 0) return m;
  const rows = db
    .prepare(
      `SELECT code, ts, price, pct, turnover, amplitude FROM (
         SELECT code, ${wall("ts")} AS ts, price, pct, turnover, amplitude,
                ROW_NUMBER() OVER (PARTITION BY code ORDER BY ${wall("ts")} DESC) AS rn
         FROM quote_snapshot WHERE code IN (${placeholders(codes.length)})
       ) WHERE rn = 1`
    )
    .all(...codes) as Array<Record<string, unknown>>;
  for (const r of rows) {
    const price = r.price === null ? NaN : Number(r.price);
    // price 为 null/0 的快照是坏行（停牌或解析失败），宁可当没有也不要交给界面
    if (!Number.isFinite(price) || price <= 0) continue;
    m.set(r.code as string, {
      code: r.code as string,
      ts: r.ts as string,
      price,
      pct: r.pct === null ? NaN : Number(r.pct),
      turnover: r.turnover === null ? NaN : Number(r.turnover),
      amplitude: r.amplitude === null ? NaN : Number(r.amplitude),
    });
  }
  return m;
}

export function dailyBars(db: Db, code: string, n: number): DailyBar[] {
  const rows = db
    .prepare(
      `SELECT code, date, o, h, l, c, vol, amount, adj_factor
       FROM kline_daily WHERE code = ? ORDER BY date DESC LIMIT ?`
    )
    .all(code, n) as Array<Record<string, unknown>>;
  return rows
    .map((r) => ({
      code: r.code as string,
      date: r.date as string,
      o: Number(r.o), h: Number(r.h), l: Number(r.l), c: Number(r.c),
      vol: Number(r.vol), amount: Number(r.amount),
      adjFactor: r.adj_factor === null ? 1 : Number(r.adj_factor),
    }))
    .reverse(); // 契约要求升序
}

export function latestDailyDate(db: Db): string | null {
  const r = db.prepare("SELECT MAX(date) AS m FROM kline_daily").get() as { m: string | null };
  return r.m ?? null;
}

export interface ZtRowUI extends ZtRow {
  name: string | null;
  turnover: number | null;
}

export function ztPool(db: Db, date: string): ZtRowUI[] {
  const rows = db
    .prepare(
      `SELECT date, code, name, lbc, seal_amt, open_times,
              first_seal_ts, last_seal_ts, sector, turnover
       FROM zt_pool WHERE date = ? ORDER BY lbc DESC, seal_amt DESC`
    )
    .all(date) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    date: r.date as string,
    code: r.code as string,
    name: (r.name as string) ?? null,
    lbc: r.lbc === null ? 1 : Number(r.lbc),
    sealAmt: r.seal_amt === null ? NaN : Number(r.seal_amt),
    openTimes: r.open_times === null ? 0 : Number(r.open_times),
    firstSealTs: (r.first_seal_ts as string) ?? null,
    lastSealTs: (r.last_seal_ts as string) ?? null,
    sector: (r.sector as string) ?? null,
    turnover: r.turnover === null ? null : Number(r.turnover),
  }));
}

export function latestZtDate(db: Db): string | null {
  const r = db.prepare("SELECT MAX(date) AS m FROM zt_pool").get() as { m: string | null };
  return r.m ?? null;
}

export function dtPool(db: Db, date: string): DtRow[] {
  const rows = db
    .prepare("SELECT date, code, seal_amt FROM dt_pool WHERE date = ?")
    .all(date) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    date: r.date as string,
    code: r.code as string,
    sealAmt: r.seal_amt === null ? NaN : Number(r.seal_amt),
  }));
}

export function sectorRank(db: Db, date: string): SectorRankRow[] {
  const rows = db
    .prepare(
      `SELECT date, ts, sector, pct, leader_code FROM sector_rank
       WHERE date = ? AND ts = (SELECT MAX(ts) FROM sector_rank WHERE date = ?)
       ORDER BY pct DESC`
    )
    .all(date, date) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    date: r.date as string,
    ts: r.ts as string,
    sector: r.sector as string,
    pct: r.pct === null ? NaN : Number(r.pct),
    leaderCode: (r.leader_code as string) ?? null,
  }));
}

export function lhbRows(db: Db, date: string): LhbRow[] {
  const rows = db
    .prepare(
      `SELECT date, code, change_type, name, explanation, explain_stat,
              net_amt, buy_amt, sell_amt, turnover_rate, deal_amount_ratio,
              close_price, change_rate, d1_chg, d5_chg, d10_chg, d20_chg, d30_chg
       FROM lhb WHERE date = ? ORDER BY net_amt DESC`
    )
    .all(date) as Array<Record<string, unknown>>;
  const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
  return rows.map((r) => ({
    date: r.date as string,
    code: r.code as string,
    changeType: r.change_type as string,
    name: (r.name as string) ?? "",
    explanation: (r.explanation as string) ?? "",
    explainStat: (r.explain_stat as string) ?? "",
    netAmt: Number(r.net_amt ?? 0),
    buyAmt: Number(r.buy_amt ?? 0),
    sellAmt: Number(r.sell_amt ?? 0),
    turnoverRate: num(r.turnover_rate),
    dealAmountRatio: num(r.deal_amount_ratio),
    closePrice: num(r.close_price),
    changeRate: num(r.change_rate),
    d1Chg: num(r.d1_chg),
    d5Chg: num(r.d5_chg),
    d10Chg: num(r.d10_chg),
    d20Chg: num(r.d20_chg),
    d30Chg: num(r.d30_chg),
  }));
}

export function latestLhbDate(db: Db): string | null {
  const r = db.prepare("SELECT MAX(date) AS m FROM lhb").get() as { m: string | null };
  return r.m ?? null;
}

export function lhbSeats(db: Db, date: string): LhbSeatRow[] {
  const rows = db
    .prepare(
      `SELECT date, code, change_type, side, dept_code, dept_name,
              buy_amt, sell_amt, net_amt, rise_prob_3d, buyer_times_3d
       FROM lhb_seat WHERE date = ? ORDER BY net_amt DESC`
    )
    .all(date) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    date: r.date as string,
    code: r.code as string,
    changeType: r.change_type as string,
    side: r.side === "sell" ? "sell" : "buy",
    deptCode: (r.dept_code as string) ?? "",
    deptName: (r.dept_name as string) ?? "",
    buyAmt: Number(r.buy_amt ?? 0),
    sellAmt: Number(r.sell_amt ?? 0),
    netAmt: Number(r.net_amt ?? 0),
    riseProb3d: r.rise_prob_3d === null ? null : Number(r.rise_prob_3d),
    buyerTimes3d: r.buyer_times_3d === null ? null : Number(r.buyer_times_3d),
  }));
}

const BOARDS: Board[] = ["主板", "创业板", "科创板", "北交所"];

function toBoard(v: unknown): Board {
  return BOARDS.includes(v as Board) ? (v as Board) : "主板";
}

export function securities(db: Db, codes: string[]): Map<string, SecurityRow> {
  const m = new Map<string, SecurityRow>();
  if (codes.length === 0) return m;
  const rows = db
    .prepare(
      `SELECT code, name, list_date, delist_date, board, is_st_history_json
       FROM security WHERE code IN (${placeholders(codes.length)})`
    )
    .all(...codes) as Array<Record<string, unknown>>;
  for (const r of rows) {
    let st: SecurityRow["isStHistory"] = [];
    if (typeof r.is_st_history_json === "string" && r.is_st_history_json) {
      try {
        st = JSON.parse(r.is_st_history_json);
      } catch {
        st = [];
      }
    }
    m.set(r.code as string, {
      code: r.code as string,
      name: (r.name as string) ?? "",
      listDate: (r.list_date as string) ?? null,
      delistDate: (r.delist_date as string) ?? null,
      board: toBoard(r.board),
      isStHistory: st,
    });
  }
  return m;
}

/** 代码/名称模糊搜索。给观察池加标的用。参数走绑定，不拼字符串 */
export function searchSecurities(db: Db, q: string, limit = 20): SecurityRow[] {
  const like = `%${q}%`;
  const rows = db
    .prepare(
      `SELECT code, name, list_date, delist_date, board, is_st_history_json
       FROM security WHERE code LIKE ? OR name LIKE ?
       ORDER BY code LIMIT ?`
    )
    .all(like, like, limit) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    code: r.code as string,
    name: (r.name as string) ?? "",
    listDate: (r.list_date as string) ?? null,
    delistDate: (r.delist_date as string) ?? null,
    board: toBoard(r.board),
    isStHistory: [],
  }));
}

/** asOf 及之前最近的一个交易日 */
export function lastTradingDay(db: Db, asOf: string): string | null {
  const r = db
    .prepare(
      "SELECT MAX(date) AS m FROM trading_calendar WHERE is_open = 1 AND date <= ?"
    )
    .get(asOf) as { m: string | null };
  return r.m ?? null;
}

export function calendarRange(db: Db): { from: string | null; to: string | null; openDays: number } {
  const r = db
    .prepare(
      "SELECT MIN(date) AS a, MAX(date) AS b, COALESCE(SUM(is_open), 0) AS o FROM trading_calendar"
    )
    .get() as { a: string | null; b: string | null; o: number };
  return { from: r.a, to: r.b, openDays: Number(r.o) };
}

// ═══════════════════════════ 策略 / 观察池 ═══════════════════════════

export interface StrategyRow {
  id: string;
  version: string;
  createdAt: string;
  active: boolean;
  factorsLock: Record<string, string> | null;
}

export function strategies(db: Db): StrategyRow[] {
  const rows = db
    .prepare(
      `SELECT id, version, created_at, active, factors_lock FROM strategy
       ORDER BY active DESC, id, version`
    )
    .all() as Array<Record<string, unknown>>;
  return rows.map((r) => {
    let lock: Record<string, string> | null = null;
    if (typeof r.factors_lock === "string" && r.factors_lock) {
      try {
        lock = JSON.parse(r.factors_lock);
      } catch {
        lock = null;
      }
    }
    return {
      id: r.id as string,
      version: r.version as string,
      createdAt: r.created_at as string,
      active: Number(r.active) === 1,
      factorsLock: lock,
    };
  });
}

export interface WatchpoolRow {
  code: string;
  name: string | null;
  account: AccountType | null;
  triggerPx: number | null;
  stopPx: number | null;
  thesis: string | null;
  addedAt: string;
  active: boolean;
}

export function watchpool(db: Db, includeInactive = false): WatchpoolRow[] {
  const sql = `SELECT code, name, account, trigger_px, stop_px, thesis, added_at, active
               FROM watchpool ${includeInactive ? "" : "WHERE active = 1"}
               ORDER BY added_at DESC`;
  const rows = db.prepare(sql).all() as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    code: r.code as string,
    name: (r.name as string) ?? null,
    account: (r.account as AccountType) ?? null,
    triggerPx: r.trigger_px === null ? null : Number(r.trigger_px),
    stopPx: r.stop_px === null ? null : Number(r.stop_px),
    thesis: (r.thesis as string) ?? null,
    addedAt: r.added_at as string,
    active: Number(r.active) === 1,
  }));
}

// ═══════════════════════════ 账户 / 持仓 / 成交 ═══════════════════════════

export interface AccountRow {
  id: string;
  name: string;
  type: AccountType;
}

export function accounts(db: Db): AccountRow[] {
  const rows = db.prepare("SELECT id, name, type FROM account ORDER BY id").all() as Array<
    Record<string, unknown>
  >;
  return rows.map((r) => ({
    id: r.id as string,
    name: r.name as string,
    type: r.type as AccountType,
  }));
}

export interface PositionRow extends Position {
  accountId: string;
}

export function positions(db: Db): PositionRow[] {
  const rows = db
    .prepare(
      `SELECT p.account_id, a.type AS acc_type, p.code, p.cost, p.qty,
              p.open_date, p.stop_px, p.thesis
       FROM position p LEFT JOIN account a ON a.id = p.account_id
       ORDER BY a.type, p.code`
    )
    .all() as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    accountId: r.account_id as string,
    // account 表缺行时不猜账户类型：归到"价值"会套用错的止损规则
    account: (r.acc_type as AccountType) ?? ("价值" as AccountType),
    code: r.code as string,
    qty: Number(r.qty),
    cost: Number(r.cost),
    openDate: r.open_date as string,
    stopPx: r.stop_px === null ? null : Number(r.stop_px),
    thesis: (r.thesis as string) ?? "",
  }));
}

export interface TradeRow {
  id: string;
  accountId: string;
  code: string;
  side: "buy" | "sell";
  px: number;
  qty: number;
  ts: string;
  fee: number;
  source: string;
  predictionId: string | null;
}

export function trades(db: Db, limit = 200): TradeRow[] {
  const rows = db
    .prepare(
      `SELECT id, account_id, code, side, px, qty, ts, fee, source, prediction_id
       FROM trade ORDER BY ts DESC LIMIT ?`
    )
    .all(limit) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    id: r.id as string,
    accountId: r.account_id as string,
    code: r.code as string,
    side: r.side === "sell" ? "sell" : "buy",
    px: Number(r.px),
    qty: Number(r.qty),
    ts: r.ts as string,
    fee: Number(r.fee ?? 0),
    source: r.source as string,
    predictionId: (r.prediction_id as string) ?? null,
  }));
}

// ═══════════════════════════ 台账：预测 / 结果 ═══════════════════════════

export function predictions(db: Db, limit = 200): Prediction[] {
  const rows = db
    .prepare(
      `SELECT id, ts, phase, code, strategy_id, action, account, trigger_px, stop_px,
              size, thesis, gear, eval_horizon, valid_until, advisor_influenced
       FROM prediction ORDER BY ts DESC LIMIT ?`
    )
    .all(limit) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    id: r.id as string,
    ts: r.ts as string,
    phase: r.phase as Phase,
    code: r.code as string,
    strategyId: r.strategy_id as string,
    action: r.action as Action,
    account: r.account as AccountType,
    triggerPx: r.trigger_px === null ? null : Number(r.trigger_px),
    stopPx: r.stop_px === null ? null : Number(r.stop_px),
    size: Number(r.size ?? 0),
    thesis: (r.thesis as string) ?? "",
    gear: r.gear as EnvGear,
    evalHorizon: Number(r.eval_horizon) as Prediction["evalHorizon"],
    validUntil: r.valid_until as string,
    advisorInfluenced: Number(r.advisor_influenced) === 1,
  }));
}

export function outcomes(db: Db, predIds: string[]): Map<string, Outcome> {
  const m = new Map<string, Outcome>();
  if (predIds.length === 0) return m;
  const rows = db
    .prepare(
      `SELECT pred_id, verdict, actual_pct, error_type, attribution, settled_at
       FROM outcome WHERE pred_id IN (${placeholders(predIds.length)})`
    )
    .all(...predIds) as Array<Record<string, unknown>>;
  for (const r of rows) {
    m.set(r.pred_id as string, {
      predId: r.pred_id as string,
      verdict: r.verdict as Verdict,
      actualPct: Number(r.actual_pct ?? 0),
      errorType: (r.error_type as ErrorType) ?? null,
      attribution: (r.attribution as string) ?? "",
      settledAt: r.settled_at as string,
    });
  }
  return m;
}

/** 预测 vs 实际时间线：一次查完，页面不再 N+1 */
export interface TimelineRow {
  prediction: Prediction;
  outcome: Outcome | null;
}

export function predictionTimeline(db: Db, limit = 200): TimelineRow[] {
  const preds = predictions(db, limit);
  const oc = outcomes(db, preds.map((p) => p.id));
  return preds.map((p) => ({ prediction: p, outcome: oc.get(p.id) ?? null }));
}

/** 结算后的预测行，胜率统计的输入 */
export interface SettledRow {
  phase: Phase;
  verdict: Verdict;
  errorType: ErrorType | null;
  advisorInfluenced: boolean;
  actualPct: number;
}

export function settledPredictions(db: Db): SettledRow[] {
  const rows = db
    .prepare(
      `SELECT p.phase, p.advisor_influenced, o.verdict, o.error_type, o.actual_pct
       FROM outcome o JOIN prediction p ON p.id = o.pred_id`
    )
    .all() as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    phase: r.phase as Phase,
    verdict: r.verdict as Verdict,
    errorType: (r.error_type as ErrorType) ?? null,
    advisorInfluenced: Number(r.advisor_influenced) === 1,
    actualPct: Number(r.actual_pct ?? 0),
  }));
}

// ═══════════════════════════ Advisor ═══════════════════════════

export interface AdvisorRow {
  ts: string;
  code: string;
  slot: string;
  value: string | null;
  mode: string;
  model: string | null;
  confidence: number | null;
  degraded: boolean;
}

export function advisorOutputs(db: Db, limit = 50): AdvisorRow[] {
  const rows = db
    .prepare(
      `SELECT ts, code, slot, value, mode, model, confidence, degraded
       FROM advisor_output ORDER BY ts DESC LIMIT ?`
    )
    .all(limit) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    ts: r.ts as string,
    code: r.code as string,
    slot: r.slot as string,
    value: (r.value as string) ?? null,
    mode: r.mode as string,
    model: (r.model as string) ?? null,
    confidence: r.confidence === null ? null : Number(r.confidence),
    degraded: Number(r.degraded) === 1,
  }));
}
