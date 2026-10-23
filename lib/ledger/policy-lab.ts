import type { Db } from "@/lib/db";
import { selectionBias, type SelectionBias } from "@/lib/backtest/selection-bias";
import {
  adjBars, adjFactorOn, baseTradingDay, directionOf, resolvePx, tradingDayOffset, type AdjBar,
} from "@/lib/ledger/reconcile";
import { PRED_COLS, toPrediction, type PredictionRow } from "@/lib/ledger/query";

/**
 * 离场规则回测（台账数据的离线重放）。
 *
 * 回答的问题很具体：**同一批已经成交过的仓位，换个离场规则能多赚多少。**
 * 它不评价选股 —— 入场时点、标的是账本里已经发生的事实，这里一律不改。
 *
 * 为什么必须建这个模块而不是拍脑袋定止盈止损：
 *   买入样本 MFE 均值 +4.29%、实际收益均值 −2.49%（2026-09 实测，口径修正后）。
 *   "涨上去又吐回去"到底是因为没有兑现规则、还是因为本来就只是随机波动，
 *   人眼看 K 线答不出来 —— 后者的话加止盈只是把噪音切成小块，期望一点不变。
 *   所以本模块同时给出**随机入场对照**（randomControl）：同一只票、同一段
 *   长度、随机换一个入场日跑同一套规则，看真实成绩落在对照分布的什么位置。
 *   落在中位数附近 = 没有入场 alpha，离场规则调不出真钱；
 *   显著靠前 = 入场有 alpha，只是被离场方式吃掉了，这时才值得调。
 *
 * 依赖方向：只用 reconcile 已经导出的取价原语（adjBars / baseTradingDay /
 * tradingDayOffset / directionOf），不自己写任何 `SELECT adj_factor` ——
 * 口径一旦分叉就是 B4 那个 bug（一边原始价一边后复权价，5 日 −8% 记成 +1008%）。
 */

/** 一条离场规则。三个阈值各自可为 null = 不设该道闸门 */
export interface ExitRule {
  /** 相对成交价 +x% 挂止盈单。null = 不止盈，一直拿到期满 */
  takeProfitPct: number | null;
  /** 相对成交价 −x% 挂止损单。null = 不止损 */
  stopPct: number | null;
  /**
   * 移动止损：自持仓期最高价回撤 x% 离场。null = 不用移动止损。
   *
   * 与固定止损可以共存：移动止损只会往上抬（peak 单调不减），
   * 所以它是固定止损的收紧，不是替换。
   */
  trailPct: number | null;
  /**
   * 最长持仓交易日数（时间止损）。到点无条件按当日收盘价走。
   * 省略 / null = 一直拿到持仓期末。
   *
   * 为什么要有这一条：持仓期长度在这套系统里一直是个**拍出来的常数**（D5），
   * 从来没被当成可寻优的参数问过。而它直接决定资金周转 —— 同样的每信号
   * 期望，占 3 天和占 20 天完全是两笔生意。有了这个轴才能在同一批信号上
   * 把"持有几天最划算"量出来，而不是拿默认值继续跑。
   */
  maxHoldDays?: number | null;
}

export type ExitReason = "止盈" | "止损" | "移动止损" | "期满" | "时限";

export interface SimulatedExit {
  /** 离场成交价（后复权基准，与 entryPx 同一数轴） */
  px: number;
  date: string;
  reason: ExitReason;
  /** 相对成交价的收益，百分点 */
  pct: number;
  /**
   * 实际占用的持仓交易日数（离场日在持仓期里的序号，从 1 起）。
   *
   * 报它是因为**每信号期望不是可以直接比较的量**：同样 +0.2%，占 3 天和占
   * 20 天是两笔完全不同的生意。槽位有限时真正要最大化的是单位占用时间的
   * 收益，而那需要知道每笔实际占了多少天 —— 止盈提前离场的笔数占得少，
   * 光看期望看不出来。
   */
  holdDays: number;
}

/**
 * 台账里一条看涨信号的可重放事实。
 *
 * **未成交的也算一条**：它发出过、没建仓，收益就是 0。
 * 只统计已成交的会把"没买"这件事从分母里抹掉，而"少买"恰恰是折让单主要的
 * 收益来源 —— 分母少了未成交那一半，算出来的每信号期望是虚的。
 * 实测看涨方向 39 条信号里只有 25 条成交，漏掉的那 14 条不是噪音，是结论的一部分。
 */
export interface ClosedSample {
  predId: string;
  code: string;
  action: string;
  horizon: number;
  /** 决策基准日 = 推荐发出时已经收盘的最后一个交易日。期满日与触发窗口都从它起算 */
  base: string;
  /** 后复权基准的成交价。未成交为 null */
  entryPx: number | null;
  entryDate: string | null;
  /** 持仓期起点：收盘价成交 → 次日起；盘中成交 → 当日就在持仓期内。未成交为 null */
  holdFrom: string | null;
  /** 期满日 = 基准日往后数 horizon 个交易日 */
  horizonEnd: string;
  /**
   * 台账原始触发价，换算到后复权基准。无触发价的推荐为 null。
   *
   * 换算是因为到价判定要在同一数轴上做：triggerPx 是决策时点按当时牌面给的原始价，
   * 而这里重放用的是后复权 K 线。基准日的因子在触发窗口内可视为恒定
   * （除权在窗口内发生的情况本就罕见，真发生了台账自己也要按同一假设走）。
   */
  triggerPxAdj: number | null;
}

/**
 * 入场规则。
 *
 * 挂单折让 discountPct 是这套系统里最要紧的一个旋钮：
 * 偏移剖面实测（2026-09 样本）提前 4~15 个交易日入场平均 +1.05%、
 * 实际入场日 −2.98%、推迟买 −3.66% —— 单调，是追高的形状。
 * 折让单同时改两件事：价格（回调了才买，买得更便宜）和**是否成交**
 * （一路不回头就不进场，收益记 0 而不是硬追上去挨那一刀）。
 * 后者才是大头：不成交不是错过，是躲开。
 */
export interface EntryRule {
  /**
   * 相对基准日收盘价的折让，正数 = 挂得更低。
   * **null = 直接用台账原始触发价**（即"现在这套"），拿它当基线才比得出改动值多少。
   */
  discountPct: number | null;
  /** 触发窗口：基准日之后最多等几个交易日，等不到就放弃这笔 */
  windowDays: number;
}

/**
 * 逐根 K 线模拟离场。
 *
 * 日内同时够到两条线时的口径：**先判止损**（保守）。
 * 一根 K 线的振幅同时覆盖止盈价和止损价时，盘口上谁先到是不知道的，
 * 日线数据答不出来。两种猜法里选对我们不利的那种 —— 反过来选会把
 * 回测成绩系统性做高，而"往好了猜"正是这类回测最常见的自我欺骗。
 *
 * 跳空单独判：开盘价已经越过阈值时，成交价只能是开盘价，拿不到挂单那个价。
 * 与 reconcile.resolveStop 的口径一致（跳空低开按开盘价卖）。
 */
export function simulateExit(bars: readonly AdjBar[], entryPx: number, rule: ExitRule): SimulatedExit | null {
  if (!(entryPx > 0) || bars.length === 0) return null;

  /** 时间止损先把持仓期切短。切到 1 根是底线：当天买次日卖已经是 T+1 的下限 */
  const truncated = rule.maxHoldDays != null && rule.maxHoldDays < bars.length;
  const hold = rule.maxHoldDays == null ? bars : bars.slice(0, Math.max(1, rule.maxHoldDays));

  const tpPx = rule.takeProfitPct == null ? null : entryPx * (1 + rule.takeProfitPct / 100);
  const slPx = rule.stopPct == null ? null : entryPx * (1 - rule.stopPct / 100);

  let peak = entryPx;
  for (let i = 0; i < hold.length; i++) {
    const b = hold[i];
    const d = i + 1;   // 持仓第几个交易日
    // 跳空：开盘就在线的另一边，只能按开盘价成交
    if (slPx != null && b.o != null && b.o <= slPx) return mk(b.o, b.date, "止损", entryPx, d);
    if (tpPx != null && b.o != null && b.o >= tpPx) return mk(b.o, b.date, "止盈", entryPx, d);

    // 盘中：止损先判
    if (slPx != null && b.l != null && b.l <= slPx) return mk(slPx, b.date, "止损", entryPx, d);
    if (tpPx != null && b.h != null && b.h >= tpPx) return mk(tpPx, b.date, "止盈", entryPx, d);

    if (b.h != null && b.h > peak) peak = b.h;
    if (rule.trailPct != null && b.l != null) {
      const level = peak * (1 - rule.trailPct / 100);
      if (b.l <= level) {
        // 跳空低开直接穿过移动止损线时同样拿开盘价
        const px = b.o != null && b.o <= level ? b.o : level;
        return mk(px, b.date, "移动止损", entryPx, d);
      }
    }
  }

  const last = hold[hold.length - 1];
  if (last.c == null) return null;
  /** 被 maxHoldDays 截断的叫"时限"，走完整个持仓期的才叫"期满" —— 两者都得记清楚，
   *  否则看离场原因分布时无法区分"规则触发"和"时间到"。 */
  return mk(last.c, last.date, truncated ? "时限" : "期满", entryPx, hold.length);
}

function mk(px: number, date: string, reason: ExitReason, entryPx: number, holdDays: number): SimulatedExit {
  return { px, date, reason, pct: ((px - entryPx) / entryPx) * 100, holdDays };
}

/**
 * 读出全部看涨方向、已成交、未作废的仓位。
 *
 * 只取看涨（买入/加仓/持有）：A 股没有常规做空渠道，看跌方向的"赚到"是
 * 账面数字不是可兑现的钱，把两边混在一个期望里会得出不能执行的结论。
 * holdFrom 的推导与 settleOne 完全一致，否则回测和台账量的不是同一段持仓。
 */
export function loadLongSamples(db: Db): ClosedSample[] {
  const rows = db.prepare(
    `SELECT ${PRED_COLS}, o.entry_px, o.entry_date
     FROM prediction p JOIN outcome o ON o.pred_id = p.id
     WHERE o.verdict != '作废' AND o.dirty_reason IS NULL
     ORDER BY p.ts`
  ).all() as Array<PredictionRow & { entry_px: number | null; entry_date: string | null }>;

  const out: ClosedSample[] = [];
  for (const r of rows) {
    const p = toPrediction(r);
    if (directionOf(p.action) !== "看涨") continue;
    const base = baseTradingDay(db, { ts: p.ts, phase: p.phase });
    const end = base == null ? null : tradingDayOffset(db, base, p.evalHorizon);
    if (base == null || end == null) continue;
    // 已成交的才推持仓期起点：无触发价的按基准日收盘成交 → 当日整根 K 线在持仓之前
    const holdFrom = r.entry_date == null ? null
      : (p.triggerPx == null ? tradingDayOffset(db, r.entry_date, 1) : r.entry_date);
    out.push({
      predId: p.id, code: p.code, action: p.action, horizon: p.evalHorizon, base,
      entryPx: r.entry_px, entryDate: r.entry_date, holdFrom, horizonEnd: end,
      triggerPxAdj: p.triggerPx == null ? null : p.triggerPx * adjFactorOn(db, p.code, base),
    });
  }
  return out;
}

/**
 * 一个样本预取好的行情。bars 从基准日**次日**一直到期满日，覆盖触发窗口 + 持仓期。
 *
 * 预取是因为留一法交叉验证要跑 25 折 × 105 组 × 24 样本 ≈ 6 万次重放，
 * 每次现查库就是 25 万次 SQL —— 而每个样本要的那一段行情在整个网格里是不变的。
 * 一次取出来在内存里切片，重放就纯粹是数组操作。
 */
export interface SampleBars {
  sample: ClosedSample;
  /** 基准日收盘价（后复权） */
  basePx: number;
  /** 台账触发价（后复权基准）。无触发价的推荐为 null，按基准收盘价挂单 */
  triggerPxAdj: number | null;
  /** bars[0] = 基准日次日，最后一根 = 期满日 */
  bars: AdjBar[];
  /**
   * 决策时点**已经涨了多少**：基准日收盘相对前 N 个交易日的涨幅（百分点）。
   *
   * 这是"追高"的直接度量。偏移剖面只能说"提前买更好"，说不出该拿什么当闸门；
   * 动量是可以在信号生成的那一刻就算出来的量，拦得住。
   */
  ret5: number | null;
  ret10: number | null;
}

export function loadSampleBars(db: Db, samples: readonly ClosedSample[]): SampleBars[] {
  const out: SampleBars[] = [];
  for (const s of samples) {
    const basePx = resolvePx(db, s.code, s.base);
    const start = tradingDayOffset(db, s.base, 1);
    if (!basePx || start == null) continue;
    const bars = adjBars(db, s.code, start, s.horizonEnd);
    if (bars.length === 0) continue;
    out.push({
      sample: s, basePx: basePx.px, triggerPxAdj: s.triggerPxAdj, bars,
      ret5: momentum(db, s.code, s.base, 5),
      ret10: momentum(db, s.code, s.base, 10),
    });
  }
  return out;
}

/** 基准日收盘相对 lookback 个交易日前的涨幅。不足 history 返回 null（不编） */
function momentum(db: Db, code: string, base: string, lookback: number): number | null {
  const rows = db.prepare(
    `SELECT date FROM kline_daily WHERE code = ? AND date <= ? ORDER BY date DESC LIMIT ?`
  ).all(code, base, lookback + 1) as Array<{ date: string }>;
  if (rows.length < lookback + 1) return null;
  const bars = adjBars(db, code, rows[rows.length - 1].date, base);
  if (bars.length < lookback + 1) return null;
  const first = bars[0].c;
  const last = bars[bars.length - 1].c;
  if (first == null || last == null || !(first > 0)) return null;
  return (last / first - 1) * 100;
}

/**
 * 动量闸门剖面：只放行动量 ≤ 阈值的信号，各阈值下的期望与剩余样本数。
 *
 * 被拦掉的信号收益记 0（没建仓），与折让单未成交同口径 —— 拦下来不是错过，
 * 是躲开。若拦掉的那批确实是亏的，期望会随阈值收紧单调往上走。
 */
export function momentumGate(
  all: readonly SampleBars[], thresholds: ReadonlyArray<number | null>,
  entry: EntryRule, exit: ExitRule, lookback: 5 | 10 = 5
): Array<{ threshold: number | null; kept: number; meanPct: number; fillRate: number }> {
  const out: Array<{ threshold: number | null; kept: number; meanPct: number; fillRate: number }> = [];
  for (const t of thresholds) {
    const kept = t == null ? all : all.filter(x => {
      const m = lookback === 5 ? x.ret5 : x.ret10;
      return m != null && m <= t;
    });
    const sc = scorePolicy(kept, entry, exit);
    // 期望按**全部**信号摊：被拦掉的算 0，不是"剩下的这批有多好"
    const total = all.length === 0 ? Number.NaN : sc.n === 0 ? 0 : (sc.meanPct * sc.n) / all.length;
    out.push({ threshold: t, kept: kept.length, meanPct: total, fillRate: sc.fillRate });
  }
  return out;
}

export interface ReplayResult {
  /** 是否成交。没成交的记 pct = 0：没建仓就不该有盈亏，不是"错过了一个收益" */
  triggered: boolean;
  /** 收益百分点。未成交恒为 0 */
  pct: number;
  exit: SimulatedExit | null;
  entryPx: number | null;
  entryDate: string | null;
  /** 占用的持仓交易日数。未成交为 0 —— 没建仓就不占资金 */
  holdDays: number;
}

/**
 * 从决策基准日重放一笔：按折让挂单，等触发，触发后按离场规则离场。
 *
 * 触发窗口从基准日**次日**起算（当日已经收盘，挂不进去），与台账
 * resolveEntry 的 `date > base` 同一口径。
 *
 * 成交价取 min(开盘价, 触发价)：低开时挂单以更好的开盘价成交，取触发价会
 * 系统性少算这部分优势（口径与 resolveEntry 的低吸分支一致）。
 */
export function replayTrade(
  sb: SampleBars, entry: EntryRule, exit: ExitRule
): ReplayResult | null {
  const trigger = entry.discountPct == null
    ? (sb.triggerPxAdj ?? sb.basePx)                  // 基线：照台账原来的触发价挂
    : sb.basePx * (1 - entry.discountPct / 100);
  const win = sb.bars.slice(0, Math.max(0, entry.windowDays));
  const idx = win.findIndex(b => b.l != null && b.l <= trigger);
  if (idx < 0) return { triggered: false, pct: 0, exit: null, entryPx: null, entryDate: null, holdDays: 0 };

  const hit = win[idx];
  const entryPx = hit.o == null ? trigger : Math.min(hit.o, trigger);
  /**
   * 持仓期从成交**次日**开始：A 股 T+1，当日买的不能当日卖。
   *
   * 漏掉这一条会系统性地把止盈规则做高 —— 止盈档位越小越依赖"当天冲高就走"，
   * 而那恰恰是 T+1 不允许的。实测不设 T+1 时止盈 2% 看起来最优（样本外 +1.37%），
   * 那个数字里有一部分是当日卖出来的，落地就是废规则。
   *
   * 末根就是期满日；成交日已是期满日时没有可卖的日子，退化按期末收盘计（罕见）。
   */
  const rest = sb.bars.slice(idx + 1);
  const ex = simulateExit(rest.length > 0 ? rest : sb.bars.slice(sb.bars.length - 1), entryPx, exit);
  if (!ex) return null;
  return { triggered: true, pct: ex.pct, exit: ex, entryPx, entryDate: hit.date, holdDays: ex.holdDays };
}

export interface PolicyScore {
  entry: EntryRule;
  exit: ExitRule;
  n: number;
  /** 已成交笔数。没成交的算 0 收益但**留在分母里** */
  filled: number;
  /** 每信号期望（百分点），未成交按 0 计入 —— 这是要最大化的目标 */
  meanPct: number;
  /** 已成交笔的平均收益，用来看"成交的那批质量如何"，与 meanPct 分开看 */
  meanPctFilled: number;
  winRate: number;
  fillRate: number;
  /**
   * 每占用一个交易日的平均收益 = 总收益 / 总占用天数（百分点）。
   *
   * 槽位有限时这个量比 meanPct 更接近真实产能：一笔占 20 天赚 0.4% 和
   * 一笔占 3 天赚 0.25%，后者每天赚 3 倍。只看 meanPct 会选错。
   * 未成交既不贡献收益也不占天数，所以不影响这个比值。
   */
  pctPerDay: number;
  /** 平均占用交易日数（只算成交的笔） */
  avgHoldDays: number;
}

/** 对一批样本跑一套完整策略（入场 + 离场） */
export function scorePolicy(
  all: readonly SampleBars[], entry: EntryRule, exit: ExitRule
): PolicyScore {
  let sum = 0;
  let sumFilled = 0;
  let wins = 0;
  let filled = 0;
  let n = 0;
  let days = 0;
  for (const sb of all) {
    const r = replayTrade(sb, entry, exit);
    if (!r) continue;
    n++;
    sum += r.pct;
    if (r.pct > 0) wins++;
    if (r.triggered) {
      filled++;
      sumFilled += r.pct;
      days += r.holdDays;
    }
  }
  return {
    entry, exit, n, filled,
    meanPct: n === 0 ? Number.NaN : sum / n,
    meanPctFilled: filled === 0 ? Number.NaN : sumFilled / filled,
    winRate: n === 0 ? Number.NaN : wins / n,
    fillRate: n === 0 ? Number.NaN : filled / n,
    pctPerDay: days === 0 ? Number.NaN : sum / days,
    avgHoldDays: filled === 0 ? Number.NaN : days / filled,
  };
}

export interface RuleScore {
  rule: ExitRule;
  n: number;
  /** 每信号平均收益（百分点）。这是要最大化的目标 */
  meanPct: number;
  /** 正收益占比 */
  winRate: number;
  /** 各离场原因的条数，用来看规则到底在干什么 */
  reasons: Record<ExitReason, number>;
  perSample: Array<{ sample: ClosedSample; exit: SimulatedExit }>;
}

/** 对一批样本跑一条规则 */
export function scoreRule(db: Db, samples: readonly ClosedSample[], rule: ExitRule): RuleScore {
  const perSample: RuleScore["perSample"] = [];
  const reasons: Record<ExitReason, number> = { 止盈: 0, 止损: 0, 移动止损: 0, 期满: 0, 时限: 0 };
  for (const s of samples) {
    if (s.entryPx == null || s.holdFrom == null) continue;   // 未成交的没有仓位可重放
    const bars = adjBars(db, s.code, s.holdFrom, s.horizonEnd);
    if (bars.length === 0) continue;
    const exit = simulateExit(bars, s.entryPx, rule);
    if (!exit) continue;
    reasons[exit.reason]++;
    perSample.push({ sample: s, exit });
  }
  const n = perSample.length;
  const meanPct = n === 0 ? Number.NaN : perSample.reduce((a, x) => a + x.exit.pct, 0) / n;
  const wins = perSample.filter(x => x.exit.pct > 0).length;
  return { rule, n, meanPct, winRate: n === 0 ? Number.NaN : wins / n, reasons, perSample };
}

/** 网格：止盈 × 止损 × 移动止损，各轴的 null 表示"不设" */
export interface RuleGrid {
  takeProfitPct: ReadonlyArray<number | null>;
  stopPct: ReadonlyArray<number | null>;
  trailPct: ReadonlyArray<number | null>;
}

export interface GridResult {
  scores: RuleScore[];
  best: RuleScore;
  /** 目标值的选择偏差：试了 N 组取最好，"挑"这个动作本身送了多少 */
  selection: SelectionBias;
  /**
   * 最优点是否孤峰。邻域 = 只动一条轴到相邻取值；邻域均值掉得越多越像过拟合。
   * 与 selection 是两件事（见 optimizer.ts 的说明）：一个看形状，一个看次数。
   */
  neighbourMeanPct: number;
  sharpness: number;
  overfitRisk: boolean;
}

/** 完整策略（入场折让 × 窗口 × 离场）网格寻优。目标 = 每信号期望 */
export function policyGridSearch(
  all: readonly SampleBars[],
  discounts: ReadonlyArray<number | null>, windows: readonly number[], exits: readonly ExitRule[]
): { scores: PolicyScore[]; best: PolicyScore; selection: SelectionBias } {
  const scores: PolicyScore[] = [];
  for (const d of discounts) {
    for (const w of windows) {
      for (const ex of exits) {
        scores.push(scorePolicy(all, { discountPct: d, windowDays: w }, ex));
      }
    }
  }
  const usable = scores.filter(s => Number.isFinite(s.meanPct));
  let best = usable[0];
  for (const s of usable) if (s.meanPct > best.meanPct) best = s;
  return {
    scores,
    best: best ?? scores[0],
    selection: selectionBias(usable.map(s => s.meanPct)),
  };
}

/**
 * 留一法交叉验证。
 *
 * 网格里那个"最好"不能拿来报成绩：它是用**全部**样本挑出来的，样本自己参与了
 * 选参数，成绩里混着"挑"这个动作的运气（selectionBias 已经在报这个了）。
 * 留一法把这件事做干净：每次留一个样本，只在剩下的 n−1 个上跑完整网格选参数，
 * 再把选出来的参数用在**它没见过**的那个样本上，记下真实收益。
 *
 * n 折做完得到的均值就是无偏的泛化期望 —— 这个数字才配写进结论。
 * 它通常比网格最优点难看得多，而那正是诚实的代价：宁可报一个难看但可信的数。
 */
export interface LoocvResult {
  folds: Array<{
    heldOutId: string;
    /** 在其余样本上选出来的参数 */
    entry: EntryRule;
    exit: ExitRule;
    /** 该参数在留出样本上的真实收益（未成交记 0） */
    realizedPct: number;
    triggered: boolean;
  }>;
  /** 泛化期望（百分点）。含未成交的 0 */
  meanPct: number;
  winRate: number;
  fillRate: number;
  /** 参数被选中次数的统计，看稳定性：如果 25 折选出 20 种不同参数，等于没选出东西 */
  chosenCounts: Array<{ entry: EntryRule; exit: ExitRule; times: number }>;
}

export function loocv(
  all: readonly SampleBars[],
  discounts: ReadonlyArray<number | null>, windows: readonly number[], exits: readonly ExitRule[]
): LoocvResult {
  const folds: LoocvResult["folds"] = [];
  for (let i = 0; i < all.length; i++) {
    const train = all.filter((_, j) => j !== i);
    const best = policyGridSearch(train, discounts, windows, exits).best;
    const r = replayTrade(all[i], best.entry, best.exit);
    folds.push({
      heldOutId: all[i].sample.predId,
      entry: best.entry,
      exit: best.exit,
      realizedPct: r?.pct ?? 0,
      triggered: r?.triggered ?? false,
    });
  }

  const tally = new Map<string, { entry: EntryRule; exit: ExitRule; times: number }>();
  for (const f of folds) {
    const k = `${f.entry.discountPct}|${f.entry.windowDays}|${f.exit.takeProfitPct}|${f.exit.stopPct}|${f.exit.trailPct}|${f.exit.maxHoldDays ?? "-"}`;
    const hit = tally.get(k);
    if (hit) hit.times++;
    else tally.set(k, { entry: f.entry, exit: f.exit, times: 1 });
  }

  const n = folds.length;
  return {
    folds,
    meanPct: n === 0 ? Number.NaN : folds.reduce((a, f) => a + f.realizedPct, 0) / n,
    winRate: n === 0 ? Number.NaN : folds.filter(f => f.realizedPct > 0).length / n,
    fillRate: n === 0 ? Number.NaN : folds.filter(f => f.triggered).length / n,
    chosenCounts: [...tally.values()].sort((a, b) => b.times - a.times),
  };
}

export const OVERFIT_SHARPNESS = 0.5;

export function gridSearch(db: Db, samples: readonly ClosedSample[], grid: RuleGrid): GridResult {
  const scores: RuleScore[] = [];
  for (const tp of grid.takeProfitPct) {
    for (const sl of grid.stopPct) {
      for (const tr of grid.trailPct) {
        scores.push(scoreRule(db, samples, { takeProfitPct: tp, stopPct: sl, trailPct: tr }));
      }
    }
  }
  const usable = scores.filter(s => Number.isFinite(s.meanPct));
  // 严格大于、并列取先遇到的：同一份输入永远给同一个答案
  let best = usable[0];
  for (const s of usable) if (s.meanPct > best.meanPct) best = s;
  if (!best) best = scores[0];

  // 邻域：三轴上各取相邻取值（只动一条轴）
  const neighbours: number[] = [];
  for (const axis of ["takeProfitPct", "stopPct", "trailPct"] as const) {
    const vals = grid[axis];
    const idx = vals.findIndex(v => v === best.rule[axis]);
    if (idx < 0) continue;
    for (const j of [idx - 1, idx + 1]) {
      if (j < 0 || j >= vals.length) continue;
      const probe = { ...best.rule, [axis]: vals[j] };
      const hit = usable.find(s => sameRule(s.rule, probe));
      if (hit) neighbours.push(hit.meanPct);
    }
  }
  const neighbourMeanPct = neighbours.length === 0
    ? best.meanPct
    : neighbours.reduce((a, b) => a + b, 0) / neighbours.length;
  const sharpness = best.meanPct > 0 ? 1 - neighbourMeanPct / best.meanPct : 0;

  return {
    scores, best,
    selection: selectionBias(usable.map(s => s.meanPct)),
    neighbourMeanPct,
    sharpness,
    overfitRisk: best.meanPct > 0 && sharpness > OVERFIT_SHARPNESS,
  };
}

function sameRule(a: ExitRule, b: ExitRule): boolean {
  return a.takeProfitPct === b.takeProfitPct && a.stopPct === b.stopPct && a.trailPct === b.trailPct;
}

/**
 * 随机入场对照。
 *
 * 每轮给每个样本在同一只票上随机换一个入场日（窗口 ±windowDays 个交易日），
 * 按当日收盘价成交、持仓同样长，跑同一条规则，得到这一轮的均值。
 * 跑 trials 轮得到零假设下的均值分布，再看真实均值落在什么分位。
 *
 * 换入场日而不是换标的：换标的等于换了波动率与行业，多出来的是风格差异不是
 * 入场时机差异，对照就没有意义了。
 */
export interface ControlOptions {
  trials?: number;
  /** 入场日可前后漂移的交易日数 */
  windowDays?: number;
  seed?: number;
  /**
   * 真实样本也按「当日收盘价成交、次日起持仓」重放，默认开。
   *
   * 关掉它会让两组口径不同：对照只能给收盘价成交（随机日没有 triggerPx，
   * 无从复制限价/触价），真实样本却是盘中成交且当日就在持仓期内。
   * 两组的差异里于是混着"选了哪天"和"怎么成交"两件事，
   * 分位低到底是时机差还是成交方式差，说不出来。开着就只剩"选哪天"这一件事。
   */
  matchFillStyle?: boolean;
}

export interface ControlResult {
  trials: number;
  /** 每轮的均值（百分点） */
  nullMeans: number[];
  nullMean: number;
  /** 真实均值在零假设分布中的分位（0~1）。>0.9 才算"入场确实有 alpha" */
  percentile: number;
  actualMeanPct: number;
}

export function randomControl(
  db: Db, samples: readonly ClosedSample[], rule: ExitRule, o: ControlOptions = {}
): ControlResult {
  const trials = o.trials ?? 200;
  const windowDays = o.windowDays ?? 15;
  const matchFill = o.matchFillStyle !== false;
  const rng = mulberry32(o.seed ?? 20261023);

  // 每个样本先把候选入场日取出来：同一批日期要反复用，别在循环里查库
  const filled = samples.filter(s => s.entryDate != null);
  const candidates = filled.map(s => loadCandidateDates(db, s.code, s.entryDate!, windowDays, s.horizon));

  const nullMeans: number[] = [];
  for (let t = 0; t < trials; t++) {
    let sum = 0;
    let n = 0;
    for (let i = 0; i < filled.length; i++) {
      const s = filled[i];
      const cands = candidates[i];
      if (cands.length === 0) continue;
      const date = cands[Math.floor(rng() * cands.length)];
      const exit = replayAtClose(db, s.code, date, s.horizon, rule);
      if (!exit) continue;
      sum += exit.pct;
      n++;
    }
    if (n > 0) nullMeans.push(sum / n);
  }

  /**
   * 真实侧也用 replayAtClose 时，两边唯一的区别就是"选了哪天入场"，
   * 这正是要问的问题。关掉 matchFillStyle 才用台账的真实成交价与真实持仓期。
   */
  let actualMeanPct: number;
  if (matchFill) {
    let sum = 0;
    let n = 0;
    for (const s of filled) {
      const exit = replayAtClose(db, s.code, s.entryDate!, s.horizon, rule);
      if (!exit) continue;
      sum += exit.pct;
      n++;
    }
    actualMeanPct = n === 0 ? Number.NaN : sum / n;
  } else {
    actualMeanPct = scoreRule(db, samples, rule).meanPct;
  }

  const nullMean = nullMeans.length === 0
    ? Number.NaN
    : nullMeans.reduce((a, b) => a + b, 0) / nullMeans.length;
  const below = nullMeans.filter(m => m < actualMeanPct).length;
  return {
    trials: nullMeans.length,
    nullMeans,
    nullMean,
    percentile: nullMeans.length === 0 ? Number.NaN : below / nullMeans.length,
    actualMeanPct,
  };
}

/**
 * 偏移剖面：把入场日相对实际入场日前后平移 k 个交易日，各偏移量下的平均收益。
 *
 * 这是"追高"最直接的体检报告。逻辑很硬：如果我们在局部高点入场，那么
 *   k < 0（提前买）应当**更差才对**——提前买会错过后面那段涨幅；
 *   反过来若 k < 0 系统性更**好**，就说明推荐发出时票已经涨完了，
 *   我们买在那一波的尾巴上，而那段涨幅恰恰是信号被触发的原因。
 *
 * 偏移用交易日在 K 线序列上的下标，不用日历日 —— 停牌/周末会让日历偏移错位。
 */
export interface OffsetPoint {
  /** 相对实际入场日的交易日偏移，负 = 提前 */
  offset: number;
  n: number;
  meanPct: number;
}

export function offsetProfile(
  db: Db, samples: readonly ClosedSample[], rule: ExitRule, windowDays = 15
): OffsetPoint[] {
  const out: OffsetPoint[] = [];
  for (let k = -windowDays; k <= windowDays; k++) {
    let sum = 0;
    let n = 0;
    for (const s of samples) {
      if (s.entryDate == null) continue;
      const date = shiftTradingDay(db, s.code, s.entryDate, k);
      if (date == null) continue;
      const exit = replayAtClose(db, s.code, date, s.horizon, rule);
      if (!exit) continue;
      sum += exit.pct;
      n++;
    }
    if (n > 0) out.push({ offset: k, n, meanPct: sum / n });
  }
  return out;
}

/** 在**该票自己的** K 线序列上平移 k 个交易日。越界返回 null（不拿别的票的日子顶） */
function shiftTradingDay(db: Db, code: string, from: string, k: number): string | null {
  if (k === 0) return from;
  const rows = db.prepare(
    `SELECT date FROM kline_daily WHERE code = ? ORDER BY date`
  ).all(code) as Array<{ date: string }>;
  const dates = rows.map(r => r.date);
  const idx = dates.indexOf(from);
  if (idx < 0) return null;
  const j = idx + k;
  return j >= 0 && j < dates.length ? dates[j] : null;
}

/**
 * 从某个入场日起、按当日收盘价成交、持仓 horizon 个交易日，跑一条规则。
 *
 * 期满日一律从**这个**入场日往后数 horizon 个交易日，不复用样本自带的 horizonEnd ——
 * 复用会让随机日的持仓期随漂移变成 20 天或 1 天，两组比的就不是同一件事了
 * （这个坑实测把对照均值推高 3.5pp，足以造出一个假的负 alpha 结论）。
 */
function replayAtClose(
  db: Db, code: string, entryDate: string, horizon: number, rule: ExitRule
): SimulatedExit | null {
  const px = resolvePx(db, code, entryDate);
  const holdFrom = tradingDayOffset(db, entryDate, 1);
  const end = tradingDayOffset(db, entryDate, horizon);
  if (!px || holdFrom == null || end == null) return null;
  const bars = adjBars(db, code, holdFrom, end);
  return bars.length === 0 ? null : simulateExit(bars, px.px, rule);
}

function loadCandidateDates(
  db: Db, code: string, center: string, windowDays: number, horizon: number
): string[] {
  const rows = db.prepare(
    `SELECT date FROM kline_daily WHERE code = ? ORDER BY date`
  ).all(code) as Array<{ date: string }>;
  const dates = rows.map(r => r.date);
  const idx = dates.indexOf(center);
  if (idx < 0) return [];
  const lo = Math.max(0, idx - windowDays);
  // 后面至少还要有 horizon 个交易日，否则这一天的持仓期量不满 ——
  // 拿半段行情凑出来的收益会和整段的混在一起，均值失真
  const hi = Math.min(dates.length - 1 - horizon, idx + windowDays);
  return hi < lo ? [] : dates.slice(lo, hi + 1);
}

/** 固定种子的 32 位 PRNG：同一个 seed 必须永远给出同一串数，否则对照跑第二次结论就变了 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
