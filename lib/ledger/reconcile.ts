import type { Db } from "@/lib/db";
import type { Action, ErrorType, Outcome, Phase, Prediction, Verdict } from "@/lib/contracts";
import {
  dateOf, EVAL_HORIZONS, PRED_COLS, round, toPrediction, type EvalHorizon, type LedgerFilter, type PredictionRow,
} from "@/lib/ledger/query";
import { listPendingPredictions } from "@/lib/ledger/record";
import { repairAdjFactorSeries } from "@/lib/factors/util";
import { isLateDecision, LATE_DECISION_NOTE, toShanghaiWall } from "@/lib/data/clock";

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
export type SkipReason = "日历不足" | "无基准价" | "无收盘价" | "无触发窗口价";

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
 * 复权/停牌跳变判据。返回标脏原因，非脏返回 null。
 *
 * 判据 1（最可靠）：与龙虎榜 dX_chg 标签背离 > 2pp。龙虎榜标签是交易所给的真实后续
 *   涨跌幅，系统算的 actual_pct 和它差这么多，几乎只能是复权/停牌问题
 *   （reconcile 自己的注释也这么写）。覆盖上榜票。
 *   **只在持有到期满时成立**：dX_chg 量的是"上榜日收盘 → X 个交易日后的收盘"，
 *   而止损离场是中途下车，两个数根本不是同一段。拿它们比会把每一笔正常止损
 *   都报成脏数据（实测 000020：止损离场 -2.84% 对上 d5_chg -14.63%，两个数都对）。
 * 判据 2（兜底）：|actual_pct| 超过该 horizon 的连板理论上限。
 *   **按主板 10% 涨停的连板极限 + 余量标定（保守口径）**：宁可把边缘大赢家少算、
 *   绝不让复权跳变把胜率撑虚。实测台账里脏数据绝大多数是主板票 5 日涨 100%+
 *   （主板 5 日连板硬上限≈61%），旧值 160 只拦了 >160% 的极端尾，把 60~160% 这段
 *   主板不可能的涨幅放进了统计，导致仪表盘出现虚假正期望。改为主板上限+缓冲后，
 *   任何主板不可能的涨幅都被隔离；代价是科创板 5 日真实大涨（上限≈149%）里超过
 *   本 cap 的部分也会被一并标脏——这是"低估"方向，比"虚高"安全。判据 1 仍是对
 *   上榜票的精确探测器，二者互补。
 */
export const DIRTY_CAP: Record<EvalHorizon, number> = {
  1: 25, 5: 70, 10: 210, 20: 750, 30: 1800,
};

export function isDirtyOutcome(
  actualPct: number | null,
  evalHorizon: EvalHorizon,
  lhbLabelPct: number | null,
  exitKind: ExitKind = "期满",
): string | null {
  if (actualPct == null) return null;
  if (exitKind === "期满" && lhbLabelPct != null && Math.abs(actualPct - lhbLabelPct) > 2) {
    return `复权/停牌背离：系统算 ${actualPct.toFixed(2)}% 与龙虎榜 d${evalHorizon}_chg ${lhbLabelPct.toFixed(2)}% 背离 > 2pp`;
  }
  const cap = DIRTY_CAP[evalHorizon];
  if (Math.abs(actualPct) > cap) {
    return `涨跌幅 ${actualPct.toFixed(2)}% 超 ${evalHorizon} 日连板理论上限 ${cap}%，疑似复权跳变`;
  }
  return null;
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
/**
 * 入参取结构化子集而不是整个 Prediction：落台账那一侧（plan/record）要在
 * **写入之前**用同一套算法算出成交日，判断这批还来不来得及 ——
 * 那里手上只有一个 ts 和 phase，还没有 Prediction 对象。
 * 成交日算法必须只有一份，两边各写一遍就会在某个 phase 上悄悄分叉。
 */
export function baseTradingDay(db: Db, p: { ts: string; phase: Phase }): string | null {
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
 * date 之前最近的一个「非 1」复权因子。
 *
 * 只用于给读侧自愈递一个起始台阶：`repairAdjFactorSeries` 从头扫时 prev 从 1 起，
 * 若窗口正好从一段非 1 台阶的中间开始，第一根被写坏的 1.0 就认不出来
 * （prev=1、f=1，看上去像"这票从没除过权"）。
 */
function priorAdjFactor(db: Db, code: string, date: string): number {
  const prior = db.prepare(
    `SELECT adj_factor f FROM kline_daily
      WHERE code = ? AND date < ? AND adj_factor IS NOT NULL AND adj_factor != 1
      ORDER BY date DESC LIMIT 1`
  ).get(code, date) as { f: number } | undefined;
  return prior && Number.isFinite(prior.f) && prior.f > 0 ? prior.f : 1;
}

/**
 * 某个交易日的复权因子（后复权基准）。
 *
 * 全账本**唯一**的取因子入口：收盘价、盘中成交价、止损成交价、MFE/MAE 全走它，
 * 任何一处自己写 `SELECT adj_factor` 都会在某一边上悄悄换口径 —— 而混口径的涨跌幅
 * 是按整段除权比例凭空偏一截，实测把 5 日 -8% 记成 +1008%（见下方 resolveEntry）。
 *
 * 自愈与 view.dailyBars 同一套：非 1 台阶之后的 1.0 是写坏的，顺延前值。
 * 该日无日线行时退回之前的最近台阶（快照取价需要），两者都没有才返回 1。
 */
export function adjFactorOn(db: Db, code: string, date: string): number {
  const bar = db.prepare(
    `SELECT COALESCE(adj_factor, 1.0) f FROM kline_daily WHERE code = ? AND date = ?`
  ).get(code, date) as { f: number } | undefined;
  const series = repairAdjFactorSeries([
    { adjFactor: priorAdjFactor(db, code, date) },
    { adjFactor: bar && Number.isFinite(bar.f) ? bar.f : 1 },
  ]);
  const f = series[series.length - 1].adjFactor;
  return typeof f === "number" && Number.isFinite(f) && f > 0 ? f : 1;
}

/**
 * 某个交易日的收盘价（后复权）。
 *
 * 日线优先；日线还没落库（当日盘后 job 之前）时退回当日最后一笔快照。
 * 快照只认同一天的：拿前一天的快照顶上等于偷偷改了 horizon。
 *
 * 收盘价乘 adj_factor（累计复权因子，见 collectors/adjust-factor），基准日与结算日
 * 才在同一复权口径下比涨跌幅。快照是原始价，同样要过这一层 —— 否则日线缺席的
 * 那几天会把整段历史按除权比例错开。
 */
export function resolvePx(db: Db, code: string, date: string): ResolvedPx | null {
  const bar = db.prepare(
    `SELECT c FROM kline_daily WHERE code = ? AND date = ?`
  ).get(code, date) as { c: number | null } | undefined;
  if (bar && bar.c != null) {
    return { px: bar.c * adjFactorOn(db, code, date), source: "kline_daily", date };
  }

  // quote_snapshot.ts 存的是 UTC ISO 串。交易时段（北京 09:30–15:00 = UTC 01:30–07:00）
  // 与盘后 job 都落在同一个 UTC 日期上，所以按前 10 位匹配是安全的；
  // 只有北京时间 08:00 前写入的快照会落到前一个 UTC 日期，而那时段没有采集。
  const snap = db.prepare(
    `SELECT price FROM quote_snapshot WHERE code = ? AND substr(ts,1,10) = ? AND price IS NOT NULL
     ORDER BY ts DESC LIMIT 1`
  ).get(code, date) as { price: number } | undefined;
  if (snap) {
    return { px: snap.price * adjFactorOn(db, code, date), source: "quote_snapshot", date };
  }

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

/**
 * 触发窗口：推荐发出后，给价格几个交易日去够到买点。
 *
 * 取 1 个交易日，和回测撮合口径**必须**一致（lib/backtest/replay.ts：
 * 决策挂到下一个可回放日，当日没成交就作废，pending 清空）。
 * 两边窗口不一样的话，回测胜率和实盘胜率就不是同一件事的两次测量，
 * 拿它们对比会得出完全错误的结论 —— 而这套复盘的全部意义就是拿它们对比。
 *
 * 语义上也站得住：09:15 给出的候选是"今天这个价可以买"，
 * 不是"未来一周内哪天到了都算"。等三天才到的价，市况已经不是当初那个市况了。
 */
export const TRIGGER_WINDOW_DAYS = 1;

export interface EntryFill {
  triggered: boolean;
  px: number;
  date: string;
  /**
   * 这笔成交是「按基准日收盘价成交」。
   * 真 表示该成交价是当日的**最后一笔**，当日整根 K 线都发生在建仓之前 ——
   * 算 MFE/MAE 时必须从次日算起，否则建仓前的涨跌会被记成持仓期间的偏移。
   */
  atClose: boolean;
}

/**
 * 限价 / 触价成交。
 *
 * 买方向按进场方式（Prediction.entryType，口径与影子盘 lib/shadow/settle.ts entryFill、
 * 回测撮合 lib/backtest/constraints.ts evaluateFill 一致）：
 *
 * 突破（触价单，打板 / 半路）：当日最高价 >= trigger_px 才算到价，成交价取 max(开盘价, trigger_px)；
 * 一字涨停（最高 = 最低）买不进，跳过那一天。触发价就是涨停价时，摸到涨停即按涨停价成交，
 * 不模拟排队（用户选定的简化模型）。
 *
 * 低吸（限价单，缺省）：当日最低价 <= trigger_px 就算够到了。成交价取 min(开盘价, trigger_px) ——
 * 低开时挂单会以更好的开盘价成交，取 trigger_px 会系统性地少算这部分优势；
 * 反过来若一路高开高走没回头，low > trigger_px，本来就不成交。
 * 卖方向对称：最高价 >= trigger_px，成交价取 max(开盘价, trigger_px)。
 *
 * 不做封板/停牌判定：那是回测撮合层的事（涨停买不进）。这里量的是
 * "价格到没到"，把两件事混在一个数里，触发率低的时候就分不清是买点定高了
 * 还是当天封死了。回测那边的 blocked 记录保留着完整分类。
 *
 * 没有 trigger_px 的推荐（清仓类无条件动作）不走限价，直接以基准收盘价成交。
 */
export function resolveEntry(
  db: Db, p: Prediction, base: string, basePx: ResolvedPx
): EntryFill | null {
  if (p.triggerPx == null) {
    return { triggered: true, px: basePx.px, date: base, atClose: true };
  }
  const dir = directionOf(p.action);
  const end = tradingDayOffset(db, base, TRIGGER_WINDOW_DAYS);
  if (!end) return null;                       // 日历没排到，交给调用方报"日历不足"
  // 突破只对买方向有意义；卖方向本来就是"最高价够到"的对称口径
  const breakout = dir !== "看跌" && p.entryType === "突破";

  const row = db.prepare(
    dir === "看跌"
      ? `SELECT date, o, h FROM kline_daily
         WHERE code = ? AND date > ? AND date <= ? AND h IS NOT NULL AND h >= ?
         ORDER BY date LIMIT 1`
      : breakout
        ? `SELECT date, o, h FROM kline_daily
           WHERE code = ? AND date > ? AND date <= ? AND h IS NOT NULL AND l IS NOT NULL
             AND h >= ? AND ABS(h - l) > 1e-9
           ORDER BY date LIMIT 1`
        : `SELECT date, o, l FROM kline_daily
           WHERE code = ? AND date > ? AND date <= ? AND l IS NOT NULL AND l <= ?
           ORDER BY date LIMIT 1`
  ).get(p.code, base, end, p.triggerPx) as { date: string; o: number | null } | undefined;

  if (!row) {
    /**
     * 没找到够价的那根 K 线，有两种完全不同的原因，必须分开：
     *   窗口内**有**行情但没到价 → 真的未触发，这是复盘要统计的结果
     *   窗口内**没有**行情（停牌、数据缺口）→ 不知道到没到，不能判
     *
     * 混成一类会让停牌和数据缺口全部计入"未触发"，把触发率系统性地压低，
     * 于是复盘会得出"买点定得太高"的结论，而真相是那几天根本没开盘。
     * 按本文件抬头的硬规矩：拿不到真价就不结算。
     */
    const any = db.prepare(
      `SELECT 1 FROM kline_daily WHERE code = ? AND date > ? AND date <= ?
         AND h IS NOT NULL AND l IS NOT NULL LIMIT 1`
    ).get(p.code, base, end);
    if (!any) return null;
    return { triggered: false, px: 0, date: end, atClose: false };
  }
  // 开盘价缺失（极少见的脏行）就退回用触发价，不猜
  // 到价判定用原始价：triggerPx 是决策时点按当时牌面给的原始价，o/h/l 也是原始价，
  // 两边同一口径才比得出"够没够到"。乘了因子再比，等于把买点按除权比例整体上移。
  const open = row.o;
  const raw = open == null ? p.triggerPx
    : dir === "看跌" || breakout ? Math.max(open, p.triggerPx) : Math.min(open, p.triggerPx);
  /**
   * 但**成交价**必须换到后复权基准，与出场价同一个数轴。
   *
   * 这里曾经漏乘，后果不是"偏一点"：入场记原始价、出场记后复权价（resolvePx 一直乘），
   * 涨跌幅就凭空多出一个完整的复权倍数。实测 002519 入场 6.13（原始）→ 出场 67.93
   * （5.67×11.98），账上记 +1008%，真实是 -8%。60 条已成交样本里 37 条这样错，
   * 其中涨得离谱的被 DIRTY_CAP 抓去标脏、剩下的直接把胜率和期望撑虚。
   *
   * 影子盘 lib/shadow/exit-slot.ts 把 o/h/l/c 整体乘 adjFactor，口径本来就对；
   * 两套账本对齐之后这里才补上。
   */
  const px = raw * adjFactorOn(db, p.code, row.date);
  // 限价/触价成交发生在当日盘中，当日剩下的走势确实还在持仓期内 → atClose=false
  return { triggered: true, px, date: row.date, atClose: false };
}

export interface Excursion {
  mfePct: number | null;
  maePct: number | null;
}

/**
 * 区间末日的替代高低价。
 *
 * 离场当日的价格不能整根 K 线都算：止损离场之后，当天剩下的走势跟你没关系了。
 * 由调用方按执行口径给当日只确知发生过的最高/最低价（见 resolveStop 的注释）。
 */
export interface RangeTail {
  date: string;
  /** 后复权基准的最高/最低价，与区间内逐根 K 线换算后的数轴一致 */
  hi: number | null;
  lo: number | null;
}

/** 后复权基准的一根 K 线。o/h/l/c 各自可能为 null —— 原始行是 null 就还是 null，不补 */
export interface AdjBar {
  date: string;
  o: number | null;
  h: number | null;
  l: number | null;
  c: number | null;
}

/**
 * 区间内的日线，o/h/l/c **整体**换到后复权基准。
 *
 * 这是账本里第二处（也是最后一处）把原始价换成后复权价的地方，另一处是 `adjFactorOn`
 * 供单点取价。两者必须走同一套自愈，否则又会出现"一边一个基准"。
 *
 * 为什么整体换而不是让调用方各自乘：调用方拿到的这根 K 线要拿来比价、算极值、
 * 模拟离场，任一步漏乘就回到 B4 那个 bug（入场原始价 vs 出场后复权价，实测把
 * 5 日 -8% 记成 +1008%）。给出去的就是成品，调用方没有乘错的机会。
 */
export function adjBars(
  db: Db, code: string, from: string, to: string, opts: { endExclusive?: boolean } = {}
): AdjBar[] {
  const cmp = opts.endExclusive ? "<" : "<=";
  const rows = db.prepare(
    `SELECT date, o, h, l, c, COALESCE(adj_factor, 1.0) f FROM kline_daily
     WHERE code = ? AND date >= ? AND date ${cmp} ? AND h IS NOT NULL AND l IS NOT NULL
     ORDER BY date`
  ).all(code, from, to) as Array<{
    date: string; o: number | null; h: number | null; l: number | null;
    c: number | null; f: number;
  }>;
  if (rows.length === 0) return [];
  const fixed = repairAdjFactorSeries([
    { adjFactor: priorAdjFactor(db, code, from) },
    ...rows.map(r => ({ adjFactor: Number.isFinite(r.f) ? r.f : 1 })),
  ]);
  const out: AdjBar[] = [];
  for (let i = 0; i < rows.length; i++) {
    const f = fixed[i + 1].adjFactor ?? 1;       // fixed[0] 是递进去的起始台阶
    const r = rows[i];
    out.push({
      date: r.date,
      o: r.o == null ? null : r.o * f,
      h: r.h == null ? null : r.h * f,
      l: r.l == null ? null : r.l * f,
      c: r.c == null ? null : r.c * f,
    });
  }
  return out;
}

/**
 * 区间内最大有利 / 不利偏移，相对成交价。
 *
 * 为什么必须有它：终点涨跌幅把"一路平推上去"和"先腰斩再拉回原地"算成同一个结果，
 * 而这两种走势对应完全不同的止损设置、完全不同的持有体验。
 * 盈亏比问的正是这两个方向各自走了多远 —— 只看终点是答不出来的。
 *
 * 方向按 direction 取：看跌的推荐，价格跌才是有利偏移。
 * 用 h/l 而不是收盘：盘中摸到就是真摸到了，止损被打掉不会因为尾盘拉回而撤销。
 *
 * 传了 tail 就只取 tail 之前的整根 K 线，tail 当日改用调用方给的高低 ——
 * 止损当天的最高价多半发生在破位之后，算进 MFE 等于把"离场后才涨到的价"记成自己的盈利。
 */
export function excursion(
  db: Db, code: string, dir: Direction, entryPx: number, from: string, to: string, tail?: RangeTail
): Excursion {
  if (entryPx <= 0) return { mfePct: null, maePct: null };
  const bound = tail ? tail.date : to;
  /**
   * 逐根取而不是 `MAX(h)`：极值要乘各自当日的复权因子，
   * 而因子是台阶 —— 区间内若跨一次除权，便宜那半段的 h 乘完因子可能反而是最高点。
   * 先取原始极值再统一乘，等于假设整段因子恒定，那正是这里要防的事。
   * 换算由 adjBars 一次做完（尾部当日要排除，故 endExclusive）。
   */
  const bars = adjBars(db, code, from, bound, { endExclusive: tail != null });

  let hi = Number.NEGATIVE_INFINITY;
  let lo = Number.POSITIVE_INFINITY;
  for (const b of bars) {
    if (b.h != null) hi = Math.max(hi, b.h);
    if (b.l != null) lo = Math.min(lo, b.l);
  }
  hi = Math.max(hi, tail?.hi ?? Number.NEGATIVE_INFINITY);
  lo = Math.min(lo, tail?.lo ?? Number.POSITIVE_INFINITY);
  if (!Number.isFinite(hi) || !Number.isFinite(lo)) return { mfePct: null, maePct: null };

  const up = ((hi - entryPx) / entryPx) * 100;
  const down = ((lo - entryPx) / entryPx) * 100;
  // 看跌时有利方向是往下，两个数对调并翻号
  const [fav, adv] = dir === "看跌" ? [-down, -up] : [up, down];
  // 有利偏移不为负、不利偏移不为正：区间含成交当日，成交价必落在 [lo, hi] 内，
  // 但脏数据（成交价来自快照而 K 线缺当日）可能违反，钳一下免得算出"最大盈利 -3%"
  return { mfePct: round(Math.max(fav, 0), 6), maePct: round(Math.min(adv, 0), 6) };
}

/** 离场方式：持有到 horizon 末收盘，还是中途被止损打出来 */
export type ExitKind = "期满" | "止损" | "止盈";

export interface ExitFill {
  kind: ExitKind;
  px: number;
  date: string;
  source: PriceSource;
}

export interface StopHit {
  date: string;
  /** 离场成交价（后复权）：跳空低开到止损之下 → 开盘价；盘中破位 → 挂单在止损价成交 */
  px: number;
  /** 是否跳空（开盘价就已经在止损之下）。跳空时只能按开盘价卖，拿不到止损价那个价 */
  gap: boolean;
  /** 破位当日开盘价（后复权）。截断 MFE 用：当天只确知开盘价在破位之前出现过 */
  open: number | null;
}

/**
 * 止损离场口径，与影子盘 lib/shadow/settle.ts 逐条对齐：
 *   跳空（开盘价已 ≤ 止损价）→ 只能以开盘价卖出，成交价 = 开盘价
 *   盘中破位           → 挂单在止损价成交，成交价 = 止损价
 *
 * 两套账本必须同一口径，否则"实盘 vs 回测"的差里混着一个纯口径差，
 * 复盘会把它当成执行损耗、去调根本不该调的参数。
 *
 * 区间含 from（含 to）。起点由调用方按成交方式给，见 settleOne 里的 holdFrom：
 * 盘中成交 → 成交当日就在持仓期内；收盘价成交 → 当日整根 K 线都在建仓之前，从次日起。
 */
export function resolveStop(
  db: Db, code: string, stopPx: number, from: string, to: string
): StopHit | null {
  const row = db.prepare(
    `SELECT date, o FROM kline_daily WHERE code = ? AND date >= ? AND date <= ?
       AND l IS NOT NULL AND l <= ? ORDER BY date LIMIT 1`
  ).get(code, from, to, stopPx) as { date: string; o: number | null } | undefined;
  if (!row) return null;
  // 破位判定（l <= stopPx）用原始价：stopPx 是原始价，两边必须同口径。
  // 判定完之后成交价与开盘价一律换到后复权基准，与入场价/期满出场价同一个数轴。
  const gap = row.o != null && row.o <= stopPx;
  const f = adjFactorOn(db, code, row.date);
  return {
    date: row.date, px: (gap ? (row.o as number) : stopPx) * f, gap,
    open: row.o == null ? null : row.o * f,
  };
}

export interface TakeProfitHit {
  date: string;
  /** 离场成交价（后复权基准，与入场价同一数轴） */
  px: number;
  /** 是否跳空高开直接越过止盈价（成交价取开盘价，比挂单价更好） */
  gap: boolean;
}

/**
 * 止盈：持仓期内第一根「最高价够到止盈价」的 K 线。
 *
 * 与 resolveStop 完全对称、方向相反：止损判低位、成交在止损价或更差的开盘价；
 * 止盈判高位、成交在止盈价或**更好**的开盘价（跳空高开时按开盘价卖，不是按挂单价）。
 *
 * 止盈价存的是原始价口径（与 triggerPx / stopPx 同源），所以比价用原始 h，
 * 算出的成交价再换到后复权基准 —— 与止损那一段同一套，混口径就是 B4 那个 bug。
 */
export function resolveTakeProfit(
  db: Db, code: string, tpPx: number, from: string, to: string
): TakeProfitHit | null {
  const row = db.prepare(
    `SELECT date, o FROM kline_daily WHERE code = ? AND date >= ? AND date <= ?
       AND h IS NOT NULL AND h >= ? ORDER BY date LIMIT 1`
  ).get(code, from, to, tpPx) as { date: string; o: number | null } | undefined;
  if (!row) return null;
  const gap = row.o != null && row.o >= tpPx;
  const f = adjFactorOn(db, code, row.date);
  return { date: row.date, px: (gap ? (row.o as number) : tpPx) * f, gap };
}

export interface SettleFacts {
  base: ResolvedPx;
  /** horizon 末的收盘价（及来源）。止损离场时它不是离场价，只留着做参照 */
  horizonClose: ResolvedPx;
  /** 真正的离场：期满收盘，或破止损离场 */
  exit: ExitFill;
  horizonEnd: string;
  /** 成交情况。未触发时 entry.triggered=false，后面所有盈亏数都为 null */
  entry: EntryFill;
  excursion: Excursion;
  /** 相对成交价的涨跌幅；未触发为 null */
  actualPct: number | null;
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
  /**
   * 晚决策作废：决策时刻（ts）在成交日 09:25 集合竞价撮合之后 → 这笔推荐不可执行。
   * 放在取价之前：作废不需要任何价格，也不该因为缺价卡在 pending 里。
   * 成交日要日历排到了才判（排不到就照常往下走，下面会报"日历不足"）。
   */
  const fillDay = tradingDayOffset(db, base, TRIGGER_WINDOW_DAYS);
  if (fillDay !== null && isLateDecision(p.ts, fillDay)) {
    return { ...head, ok: true, outcome: voidOutcome(p, fillDay, opts.now ?? new Date().toISOString()) };
  }

  const horizonEnd = tradingDayOffset(db, base, p.evalHorizon);
  if (!horizonEnd) {
    return { ...head, ok: false, reason: "日历不足", detail: `${base} 之后不足 ${p.evalHorizon} 个交易日` };
  }

  const basePx = resolvePx(db, p.code, base);
  if (!basePx) return { ...head, ok: false, reason: "无基准价", detail: `${base} 无日线也无快照` };
  const exitPx = resolvePx(db, p.code, horizonEnd);
  if (!exitPx) return { ...head, ok: false, reason: "无收盘价", detail: `${horizonEnd} 无日线也无快照` };

  const direction = directionOf(p.action);
  const bandPct = opts.bands?.[p.evalHorizon] ?? NEUTRAL_BAND_PCT[p.evalHorizon];

  const entry = resolveEntry(db, p, base, basePx);
  if (!entry) {
    // resolveEntry 返回 null 有两种情形，报出来的原因必须能区分：
    // 日历没排到（系统问题）vs 窗口内没有行情（停牌/缺口，等数据补上还能结）
    const end = tradingDayOffset(db, base, TRIGGER_WINDOW_DAYS);
    return end === null
      ? { ...head, ok: false, reason: "日历不足", detail: `${base} 之后不足 ${TRIGGER_WINDOW_DAYS} 个交易日，判不了触发` }
      : { ...head, ok: false, reason: "无触发窗口价", detail: `${base}~${end} 无日线（停牌或数据缺口），判不了到没到买点` };
  }

  /**
   * 止损只对「已经成了仓位」且「方向看涨」的推荐成立。
   *
   *   没成交 → 压根没有仓位，谈不上被止损打出来；
   *   看跌（减仓/清仓）→ 止损价是那份**多头**仓位的下方风控线，价格往下走正是
   *     这个判断想要的方向，把它判成"止损"等于把赚钱说成亏钱。
   *     归因模块（attribution.ts）也只按 isLong 用 stopBreached，两边必须一致。
   *
   * 破止损就用止损口径离场，不再按 horizon 末收盘 ——
   * 一边记账"这条有止损"、一边按"硬扛到期满"算盈亏，是把两个互不相容的假设
   * 缝在同一个数里：最坏的那批样本会被记成一路扛到底的巨亏，
   * 于是策略看上去"止损位设得没用"，而真相是账本压根没执行过止损。
   * 反过来，改完之后的数字才配叫"带纪律执行的期望收益"。
   */
  /**
   * 持仓期起点。止损区间与 MFE/MAE **共用**这一个起点 —— 两件事问的是同一个问题
   * （"建仓之后价格走到过哪"），各算一个起点就会在某个成交方式上悄悄分叉。
   *
   *   收盘价成交（无 triggerPx）：成交价是当日最后一笔，当日整根 K 线都在建仓之前，
   *     从次日起算。否则建仓前的回撤会被记成持仓期回撤，止损位建议被系统性放宽。
   *   盘中成交（限价 / 触价）：成交之后的走势确实还在持仓期内，成交当日算进来。
   *     日线给不出当日"先破位还是先成交"的先后，一律按成交后破位处理 ——
   *     这是偏严的一边，而偏严只是少算一点盈利，偏松会把没发生的亏损记成纪律失效。
   */
  const holdFrom = entry.atClose ? tradingDayOffset(db, entry.date, 1) : entry.date;
  /**
   * 离场最早从成交**次日**起 —— A 股 T+1，当日买的不能当日卖。
   *
   * 与 holdFrom 分开是必须的：MFE/MAE 量的是「持仓期间出现过什么价」，当日买入后
   * 隔夜那段波动确实是这笔仓位经历过的；但止损/止盈是**可执行路径**，当日离场那条路
   * 现实里不存在。此前两个用途共用一个起点，盘中成交时等于允许当日买入当日止损离场
   * （见 migrations/033 的实测代价：不设 T+1 时止盈 2% 看起来最优，那是假的）。
   */
  const exitFrom = tradingDayOffset(db, entry.date, 1);
  const stop = entry.triggered && direction === "看涨" && p.stopPx != null && exitFrom !== null
    ? resolveStop(db, p.code, p.stopPx, exitFrom, horizonEnd)
    : null;
  const takeProfit = entry.triggered && direction === "看涨" && p.takeProfitPx != null && exitFrom !== null
    ? resolveTakeProfit(db, p.code, p.takeProfitPx, exitFrom, horizonEnd)
    : null;
  const stopBreached = stop !== null;
  const stopBreachDate = stop?.date ?? null;

  /**
   * 同一天既够到止盈又够到止损时按**止损**算（保守）。
   * 日线给不出当日先后，两种猜法里选对我们不利的那一种 —— 往好了猜会把结算
   * 系统性做高，而"往好了猜"正是这类回测最常见的自我欺骗。
   */
  const tpFirst = takeProfit !== null && (stop === null || takeProfit.date < stop.date);
  const exitFill: ExitFill = stop !== null && !tpFirst
    ? { kind: "止损", px: stop.px, date: stop.date, source: "kline_daily" }
    : takeProfit !== null && tpFirst
      ? { kind: "止盈", px: takeProfit.px, date: takeProfit.date, source: "kline_daily" }
      : { kind: "期满", px: exitPx.px, date: horizonEnd, source: exitPx.source };

  // 价格没够到推荐的买点 —— 这笔推荐从未成为一个仓位，没有盈亏可算。
  // 它仍然要结算、要落库：未触发本身就是复盘要统计的结果之一
  // （买点定得够不到，和选股选错了，是两种病）。
  const actualPct = entry.triggered
    ? round(((exitFill.px - entry.px) / entry.px) * 100, 6)
    : null;
  const excur = entry.triggered && holdFrom !== null
    ? excursion(
        db, p.code, direction, entry.px, holdFrom, horizonEnd,
        // 离场当天不取整根 K 线：只确知开盘价在离场前出现过，之后的高低与你无关。
        // 整根算进去等于把"卖掉之后才涨到/跌到的价"记成自己的持仓经历
        stop !== null && exitFill.kind === "止损"
          ? { date: stop.date, hi: stop.open, lo: stop.px }
          : takeProfit !== null && exitFill.kind === "止盈"
            ? { date: takeProfit.date, hi: takeProfit.px, lo: null }
            : undefined
      )
    : { mfePct: null, maePct: null };

  const label = lhbLabelPct(db, p.code, base, p.evalHorizon);
  // 复权/停牌脏数据：actual_pct 因复权因子写坏或长期停牌复牌会失真（典型 5 日涨 1000%+），
  // 进胜率/盈亏比会把它撑到失真。识别出来后隔离 —— 不可信，降级为中性、不进任何统计分母，
  // 但 actual_pct 仍保留真实失真值让人眼核查（见 Outcome.dirtyReason）。
  const dirtyReason = entry.triggered
    ? isDirtyOutcome(actualPct, p.evalHorizon, label, exitFill.kind)
    : null;

  const verdict: Verdict = entry.triggered
    ? verdictOf(direction, actualPct as number, bandPct)
    : "未触发";
  // 脏数据不篡改"判定"语义，但落库与统计用有效判定：脏 → 中性（排除）
  const effectiveVerdict: Verdict = dirtyReason ? "中性" : verdict;

  const facts: SettleFacts = {
    base: basePx, horizonClose: exitPx, exit: exitFill, horizonEnd, entry, excursion: excur,
    actualPct, direction, bandPct, stopBreached, stopBreachDate, lhbLabelPct: label,
  };

  let attribution: string;
  if (!entry.triggered) {
    attribution =
      `D${p.evalHorizon} 基准 ${base} ${basePx.px}(${basePx.source})；` +
      `买点 ${p.triggerPx} 在 ${TRIGGER_WINDOW_DAYS} 个交易日内未触及 → 未触发（不进胜率分母）`;
  } else {
    const sign = (actualPct as number) >= 0 ? "+" : "";
    attribution =
      `D${p.evalHorizon} 成交 ${entry.date} ${round(entry.px, 4)} → ${exitFill.date} ` +
      `${round(exitFill.px, 4)}(${exitFill.kind}/${exitFill.source})` +
      ` = ${sign}${(actualPct as number).toFixed(2)}%，${direction}／中性带 ±${bandPct}% → ${effectiveVerdict}`;
    if (excur.mfePct != null && excur.maePct != null) {
      attribution += `；区间最大有利 +${excur.mfePct.toFixed(2)}% / 最大不利 ${excur.maePct.toFixed(2)}%`;
    }
  }
  if (entry.triggered && label != null && Math.abs(label - (actualPct as number)) > 2) {
    if (dirtyReason) {
      attribution += `；复权脏数据已隔离，不进胜率/盈亏比（${dirtyReason}）`;
    } else {
      // 背离通常意味着复权/停牌，报出来让人看，不自动改判
      attribution += `；⚠与龙虎榜 d${p.evalHorizon}_chg ${label.toFixed(2)}% 背离`;
    }
  }
  if (stopBreached && stop !== null) {
    attribution += `；${stopBreachDate} 破止损 ${p.stopPx}` + (stop.gap
      ? `（跳空低开已在线下，按开盘价 ${round(stop.px, 4)} 离场）`
      : `，按止损价 ${round(stop.px, 4)} 离场，不再按 ${horizonEnd} 收盘 ${round(exitPx.px, 4)} 计`);
  }

  const extra = opts.attribute?.(p, facts, effectiveVerdict) ?? null;
  const outcome: Outcome = {
    predId: p.id,
    verdict: effectiveVerdict,
    actualPct,
    dirtyReason: dirtyReason ?? null,
    errorType: extra?.errorType ?? null,
    attribution: extra ? `${attribution}｜${extra.attribution}` : attribution,
    settledAt: opts.now ?? new Date().toISOString(),
    // trigger_px 为空的推荐无条件执行，"触发"这件事对它不适用 —— 记 null 而不是 true，
    // 否则触发率的分母里会混进一批从来不需要够价的单子，把这个数拉高
    triggered: p.triggerPx == null ? null : entry.triggered,
    entryPx: entry.triggered ? round(entry.px, 4) : null,
    entryDate: entry.triggered ? entry.date : null,
    mfePct: excur.mfePct,
    maePct: excur.maePct,
  };
  return { ...head, ok: true, facts, outcome };
}

/** 作废的结算：没有成交、没有盈亏、没有错因，只有一句为什么 */
function voidOutcome(p: Prediction, fillDay: string, settledAt: string): Outcome {
  return {
    predId: p.id, verdict: "作废", actualPct: null, errorType: null,
    attribution: `${LATE_DECISION_NOTE}（决策 ${toShanghaiWall(p.ts)}，成交日 ${fillDay}）→ 作废（不进任何统计）`,
    settledAt, triggered: null, entryPx: null, entryDate: null, mfePct: null, maePct: null,
  };
}

/**
 * 把已经结算、但决策晚于成交日 09:25 的老行原地改判作废。
 *
 * 台账只追加不改写 —— 这是唯一的例外，理由：那些结算本身就是错的（拿决策之前就发生了的
 * 开盘价成交），而用户 2026-10-09 选定把它们作废。判据只有一份（settleOne 里同一个
 * isLateDecision），每次对账开跑先扫一遍：幂等，已作废的不再碰；跑过一次就修好了历史。
 * prediction 表一天一批，全表扫的代价可以忽略。
 */
export function voidLateSettled(db: Db, now: string = new Date().toISOString()): number {
  const rows = db.prepare(
    `SELECT ${PRED_COLS} FROM prediction p JOIN outcome o ON o.pred_id = p.id
      WHERE o.verdict != '作废'`
  ).all() as PredictionRow[];
  const up = db.prepare(
    `UPDATE outcome SET verdict = '作废', actual_pct = NULL, error_type = NULL, attribution = ?,
       settled_at = ?, triggered = NULL, entry_px = NULL, entry_date = NULL, mfe_pct = NULL, mae_pct = NULL
     WHERE pred_id = ? AND verdict != '作废'`
  );
  let n = 0;
  db.transaction(() => {
    for (const r of rows) {
      const p = toPrediction(r);
      const base = baseTradingDay(db, p);
      const fillDay = base === null ? null : tradingDayOffset(db, base, TRIGGER_WINDOW_DAYS);
      if (fillDay === null || !isLateDecision(p.ts, fillDay)) continue;
      n += up.run(voidOutcome(p, fillDay, now).attribution, now, p.id).changes;
    }
  })();
  return n;
}

/**
 * 把已结算、但属于复权/停牌脏数据的老行就地标脏。
 *
 * 台账只追加不改写 —— 这是唯一的例外，理由：那些结算的 actual_pct 本身就是错的
 * （复权因子写坏或长期停牌复牌），而用户 2026-10-21 选定把它们隔离。判据只有一份
 * （settleOne 里同一个 isDirtyOutcome），每次对账开跑先扫一遍：幂等，已标脏的不再碰；
 * 跑过一次就修好了历史。
 *
 * 与 voidLateSettled 不同：这里**保留** actual_pct 真实失真值（让人眼核查），只把它
 * 降级为中性、填上 dirty_reason，让它不进任何统计分母。
 */
export function markDirtySettled(db: Db, now: string = new Date().toISOString()): number {
  const rows = db.prepare(
    `SELECT ${PRED_COLS} FROM prediction p JOIN outcome o ON o.pred_id = p.id
      WHERE o.dirty_reason IS NULL AND o.verdict != '作废'`
  ).all() as PredictionRow[];
  const up = db.prepare(
    `UPDATE outcome SET verdict = '中性', dirty_reason = ?,
       attribution = COALESCE(attribution, '') || ?
     WHERE pred_id = ? AND dirty_reason IS NULL`
  );
  let n = 0;
  db.transaction(() => {
    for (const r of rows) {
      const p = toPrediction(r);
      const base = baseTradingDay(db, p);
      if (base === null) continue;
      const label = lhbLabelPct(db, p.code, base, p.evalHorizon);
      const o = db.prepare("SELECT actual_pct FROM outcome WHERE pred_id = ?").get(p.id) as
        { actual_pct: number | null } | undefined;
      if (!o) continue;
      // 离场方式决定判据 1 能不能用（止损离场与龙虎榜 dX_chg 不是同一段，见 isDirtyOutcome）。
      // 重算不出来时退回"期满"：那是最严的一边，宁可多标一条也不放过真跳变
      const kind = settleOne(db, p, { now }).facts?.exit.kind ?? "期满";
      const reason = isDirtyOutcome(o.actual_pct, p.evalHorizon, label, kind);
      if (reason == null) continue;
      n += up.run(reason, `；复权脏数据已隔离，不进胜率/盈亏比（${reason}）`, p.id).changes;
    }
  })();
  return n;
}

function sameNum(a: number | null, b: number | null): boolean {
  if (a == null || b == null) return a == null && b == null;
  return Math.abs(a - b) < 1e-9;
}

/**
 * 把已结算、但区间内破过止损的老行按止损口径重结。
 *
 * 台账只追加不改写 —— 这是第三个例外，理由与另两个同源：那些行的 actual_pct 是按
 * "硬扛到 horizon 末"算出来的，而同一条推荐明确写了止损价，两个数不能同时成立。
 * 留着旧数，"带纪律执行的期望收益"这个指标从第一天起就是假的。
 *
 * 幂等：重结的输入（entry_px / entry_date / stop_px / horizon）都是落库时就固定的，
 * 重跑必然算出同一个值 —— 与库里一致就跳过。所以 settled_at 不会每次跑都跳，
 * 已经结对的错因也不会被反复清空。
 *
 * 脏数据行不动：它的 actual_pct 因复权跳变失真，重算出来同样失真，
 * 而且它本来就不进任何分母（NOT_DIRTY）。
 *
 * 重结会顺带把 error_type 清空、去掉旧的错因后缀：错因是对着旧事实归的，
 * 事实变了还留着它，等于给新数配旧解释。空的错因由随后的 attributeSettled 补回来。
 */
export function resettleStoppedOut(db: Db, now: string = new Date().toISOString()): number {
  const rows = db.prepare(
    `SELECT ${PRED_COLS} FROM prediction p JOIN outcome o ON o.pred_id = p.id
      WHERE o.verdict != '作废' AND o.dirty_reason IS NULL AND o.entry_px IS NOT NULL`
  ).all() as PredictionRow[];
  const up = db.prepare(
    `UPDATE outcome SET verdict = ?, actual_pct = ?, mfe_pct = ?, mae_pct = ?,
       attribution = ?, error_type = NULL, settled_at = ?
     WHERE pred_id = ? AND dirty_reason IS NULL AND verdict != '作废'`
  );
  const cur = db.prepare(
    "SELECT actual_pct, mfe_pct, mae_pct FROM outcome WHERE pred_id = ?"
  );
  let n = 0;
  db.transaction(() => {
    for (const r of rows) {
      const p = toPrediction(r);
      const att = settleOne(db, p, { now });
      if (!att.ok || !att.outcome || att.facts?.stopBreached !== true) continue;
      const o = att.outcome;
      const old = cur.get(p.id) as
        { actual_pct: number | null; mfe_pct: number | null; mae_pct: number | null } | undefined;
      if (!old) continue;
      if (sameNum(old.actual_pct, o.actualPct) && sameNum(old.mfe_pct, o.mfePct)
        && sameNum(old.mae_pct, o.maePct)) continue;
      n += up.run(o.verdict, o.actualPct, o.mfePct, o.maePct, o.attribution, o.settledAt, p.id).changes;
    }
  })();
  return n;
}

/**
 * 把已结算、但成交价与离场价不在同一复权基准上的老行全量重结。
 *
 * 台账只追加不改写 —— 这是第四个例外，理由比前三个更硬：那些行的涨跌幅里
 * **凭空多出一个完整的复权倍数**（入场记原始价、出场记后复权价），
 * 实测 60 条已成交样本里 37 条这样错，5 日 -8% 被记成 +1008%。
 * 留着旧数，胜率、盈亏比、期望收益三个数从第一天起全是假的。
 *
 * 与 resettleStoppedOut 的两个区别：
 *   1. **包含脏行**。脏行正是被这个 bug 造出来的那批，重结之后 actual_pct 回到
 *      正常量级、dirty_reason 自然变 null —— 这就是"把样本救回来"，也是修根因
 *      与打标脏补丁的分界线：标脏是把错的数藏起来，重结是把错的数改对。
 *   2. 连 entry_px / verdict / dirty_reason 一起改。错的不只是盈亏，连"成交在哪个价"
 *      都是原始价，下游读它算仓位、算止损距离的都会跟着错。
 *
 * 幂等：重结的输入全部来自 prediction 与 kline_daily，重跑必然算出同一组值，
 * 与库里一致就跳过 —— settled_at 不会每轮跳，错因也不会被反复清空。
 *
 * 同样清掉 error_type：错因是对着旧事实归的，事实变了还留着等于给新数配旧解释。
 */
export function resettlePriceBasis(db: Db, now: string = new Date().toISOString()): number {
  const rows = db.prepare(
    `SELECT ${PRED_COLS} FROM prediction p JOIN outcome o ON o.pred_id = p.id
      WHERE o.verdict != '作废'`
  ).all() as PredictionRow[];
  const up = db.prepare(
    `UPDATE outcome SET verdict = ?, actual_pct = ?, dirty_reason = ?, mfe_pct = ?, mae_pct = ?,
       entry_px = ?, entry_date = ?, triggered = ?, attribution = ?, error_type = NULL, settled_at = ?
     WHERE pred_id = ? AND verdict != '作废'`
  );
  const cur = db.prepare(
    `SELECT verdict, actual_pct, dirty_reason, mfe_pct, mae_pct, entry_px, entry_date, triggered
       FROM outcome WHERE pred_id = ?`
  );
  let n = 0;
  db.transaction(() => {
    for (const r of rows) {
      const p = toPrediction(r);
      const att = settleOne(db, p, { now });
      if (!att.ok || !att.outcome) continue;
      const o = att.outcome;
      const old = cur.get(p.id) as
        | { verdict: string; actual_pct: number | null; dirty_reason: string | null;
            mfe_pct: number | null; mae_pct: number | null; entry_px: number | null;
            entry_date: string | null; triggered: number | null }
        | undefined;
      if (!old) continue;
      const oldTriggered = old.triggered == null ? null : old.triggered === 1;
      if (old.verdict === o.verdict
        && (old.dirty_reason ?? null) === (o.dirtyReason ?? null)
        && oldTriggered === o.triggered
        && (old.entry_date ?? null) === (o.entryDate ?? null)
        && sameNum(old.actual_pct, o.actualPct)
        && sameNum(old.mfe_pct, o.mfePct)
        && sameNum(old.mae_pct, o.maePct)
        && sameNum(old.entry_px, o.entryPx)) continue;
      n += up.run(
        o.verdict, o.actualPct, o.dirtyReason ?? null, o.mfePct, o.maePct,
        o.entryPx, o.entryDate, o.triggered == null ? null : o.triggered ? 1 : 0,
        o.attribution, o.settledAt, p.id
      ).changes;
    }
  })();
  return n;
}

export interface ReconcileReport {
  asOf: string;
  /** 本次扫到的到期未结算条数 */
  scanned: number;
  /** 本次把已结算老行改判作废的条数（新结算出的作废在 settled 里，verdict = 作废） */
  revoided: number;
  /** 本次把已结算老行按统一复权基准重结的条数（口径错的历史行） */
  readjusted: number;
  /** 本次把已结算老行标脏（复权/停牌跳变）的条数 */
  redirtied: number;
  /** 本次把已结算老行按止损口径重结的条数 */
  restopped: number;
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
  const revoided = voidLateSettled(db, opts.now);
  // 复权基准重结放在标脏之前：重结之后原本离谱的数回到正常量级，就不该再被标脏；
  // 标脏留在后面只做兜底（重结算不出来的行，靠原始 actual_pct 判）
  const readjusted = resettlePriceBasis(db, opts.now);
  const redirtied = markDirtySettled(db, opts.now);
  const restopped = resettleStoppedOut(db, opts.now);
  const pending = listPendingPredictions(db, asOf, opts.filter ?? {}, opts.limit);

  const settled: Outcome[] = [];
  const skipped: SettleAttempt[] = [];
  const stmt = db.prepare(
    `INSERT INTO outcome (pred_id, verdict, actual_pct, error_type, attribution, settled_at,
       triggered, entry_px, entry_date, mfe_pct, mae_pct, dirty_reason)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(pred_id) DO NOTHING`
  );

  for (const p of pending) {
    const att = settleOne(db, p, opts);
    if (!att.ok || !att.outcome) { skipped.push(att); continue; }
    const o = att.outcome;
    const info = stmt.run(
      o.predId, o.verdict, o.actualPct, o.errorType, o.attribution, o.settledAt,
      o.triggered == null ? null : o.triggered ? 1 : 0,
      o.entryPx, o.entryDate, o.mfePct, o.maePct, o.dirtyReason ?? null
    );
    if (info.changes > 0) settled.push(o);
  }
  return {
    asOf, scanned: pending.length, revoided, readjusted, redirtied, restopped, settled, skipped,
  };
}
