import type {
  AccountType, BacktestMetrics, BacktestReport, Candidate, Constraints, DailyBar,
  EquityPoint, PointInTimeView, Phase, SecurityRow, StrategyConfig, StrategyEngine,
} from "@/lib/contracts";
import { DEFAULT_CONSTRAINTS } from "@/lib/contracts";
import {
  DEFAULT_FILL_OPTIONS, LOT, evaluateFill, sellableQty,
} from "@/lib/backtest/constraints";
import type { FillOptions } from "@/lib/backtest/constraints";
import { buildCoverageReport } from "@/lib/backtest/coverage";
import type { CoverageReportDetail } from "@/lib/backtest/coverage";
import { computeResultHash } from "@/lib/backtest/hash";
import { computeMetricsDetailed } from "@/lib/backtest/metrics";
import type {
  BlockedRecord, ClosedTrade, MarketState, ReplayDecision, ReplayPosition, ReplayTrade,
} from "@/lib/backtest/types";

/**
 * 日频重放引擎。
 *
 * 每个交易日的顺序是显式的，且顺序本身就是防未来函数的核心：
 *
 *   1. 该日有未解决的数据缺口 → **跳过并计数**（spec §10.5），绝不插值、绝不顺延决策；
 *   2. 建当日视图 view = viewFactory(d)（视图负责只吐 d 及之前的数据）；
 *   3. 用**今日行情**执行**昨日决策**（先卖后买，卖出腾出现金）；
 *   4. 处理退市：持仓票掉出 view.universe() 就强制清算（spec §10.2）；
 *   5. 按今日收盘估值，落一个净值点；
 *   6. 最后才调策略，产出的决策挂到明日。
 *
 * 第 3 步与第 6 步的先后不能颠倒，颠倒了就是"当日收盘决策 + 当日收盘成交"，
 * 也就是回测最经典的自欺：曲线漂亮、实盘归零。enforceNoLookAhead 是这条纪律的运行期兜底。
 *
 * 标的池只来自 view.universe()，回测层不自己拼当前证券清单 —— 那等于假装当年买的没一只退市。
 */

export interface RunBacktestOptions {
  from: string;
  to: string;
  /** 注入：每个交易日的 PIT 视图。回测层不认识 lib/pit 的实现 */
  viewFactory: (asOf: string) => PointInTimeView;
  /** 注入：策略引擎（契约类型）。回测层不认识 lib/strategy 的实现 */
  strategy: StrategyEngine;
  config: StrategyConfig;
  initialCash: number;
  constraints?: Constraints;
  fill?: FillOptions;
  /** 决策相位。日频重放默认收盘后决策、次日执行 */
  phase?: Phase;
  /** proxy-audit 的产出，进覆盖率报告首页 */
  lowConfidenceFactors?: Array<{ name: string; rho: number }>;
  /** spec R1 复权断层是否已解决。默认 false = 有效区间诚实缩到 2024 起 */
  adjFactorResolved?: boolean;
  /**
   * 报告信封时间戳。**必须外部注入**：重放路径内不许出现 Date.now()，
   * 否则同份输入两次跑出的报告不一致（spec §17 断言 4）。不传就留空。
   */
  generatedAt?: string;
  /**
   * 退市清算回收率。默认 1 = 按最后已知收盘价清算，这是**乐观**假设：
   * 真实退市整理期常见 −70% 以上。想要保守就把它调低，别默认骗自己。
   */
  delistRecoveryRate?: number;
}

export interface ReplayDetail {
  trades: ReplayTrade[];
  closed: ClosedTrade[];
  blocked: BlockedRecord[];
  /** 因缺口跳过的交易日 */
  skippedDays: string[];
  replayedDays: string[];
  /** 因缺口日被丢弃的待执行决策数 */
  droppedDecisions: number;
  /** 最后一天产出、无日可执行的决策数 */
  unexecutedDecisions: number;
  delistLiquidations: number;
  coverage: CoverageReportDetail;
  /** metrics 的退化原因，非空说明 Calmar 被记 0 */
  degeneracy: string[];
  generatedAt: string | null;
}

export interface ReplayOutcome {
  report: BacktestReport;
  detail: ReplayDetail;
}

/** 决策日必须严格早于成交日。相等即"同 bar 决策同 bar 成交" —— 未来函数 */
export function enforceNoLookAhead(decidedOn: string, execDate: string): void {
  if (decidedOn >= execDate) {
    throw new Error(`未来函数：决策日 ${decidedOn} 不早于成交日 ${execDate}`);
  }
}

function posKey(account: AccountType, code: string): string {
  return `${account}|${code}`;
}

function isStOn(sec: SecurityRow | null, date: string): boolean {
  if (!sec) return false;
  return sec.isStHistory.some((w) => w.from <= date && (w.to === null || date <= w.to));
}

/** 从视图取当日与前一日日线，拼成撮合需要的市场状态 */
function marketStateOf(view: PointInTimeView, code: string, date: string): MarketState {
  const bars = view.dailyBars(code, 2);
  const today = bars.length > 0 && bars[bars.length - 1].date === date ? bars[bars.length - 1] : null;
  const prev = today
    ? (bars.length > 1 ? bars[bars.length - 2].c : null)
    : (bars.length > 0 ? bars[bars.length - 1].c : null);
  const sec = view.security(code);
  const zt = view.ztPool(date).find((r) => r.code === code) ?? null;
  const dt = view.dtPool(date).find((r) => r.code === code) ?? null;
  return {
    date, code,
    board: sec?.board ?? "主板",
    isSt: isStOn(sec, date),
    listDate: sec?.listDate ?? null,
    bar: today, prevClose: prev, zt, dt,
  };
}

function lastKnownClose(view: PointInTimeView, code: string): number | null {
  const bars = view.dailyBars(code, 1);
  return bars.length > 0 ? bars[bars.length - 1].c : null;
}

/**
 * 把信号卡的候选翻成可执行决策。
 * 仓位换股数用**决策日**收盘价折算（决策时唯一已知的价格），成交价另算，两者不能混。
 */
function decisionsFrom(
  candidates: Candidate[], view: PointInTimeView, date: string,
  positions: Map<string, ReplayPosition>, equity: number,
  blocked: BlockedRecord[]
): ReplayDecision[] {
  const out: ReplayDecision[] = [];
  for (const c of candidates) {
    if (c.action === "持有" || c.action === "观察") continue;
    const key = posKey(c.account, c.code);
    const pos = positions.get(key);

    if (c.action === "买入" || c.action === "加仓") {
      const basePx = lastKnownClose(view, c.code);
      if (basePx === null || basePx <= 0) {
        blocked.push({ date, code: c.code, side: "buy", blockedBy: "无价格基准", reason: "决策日无收盘价可折算仓位", wantQty: 0 });
        continue;
      }
      const qty = Math.floor((equity * c.size) / basePx / LOT) * LOT;
      if (qty < LOT) {
        blocked.push({ date, code: c.code, side: "buy", blockedBy: "不足一手", reason: `目标仓位 ${c.size} 折算不足一手（基准价 ${basePx}）`, wantQty: qty });
        continue;
      }
      out.push({ decidedOn: date, code: c.code, account: c.account, side: "buy", limitPx: c.triggerPx, stopPx: c.stopPx, qty, thesis: c.thesis, action: c.action });
      continue;
    }

    // 卖出侧：清仓卖全部，减仓卖一半（取整到一手，不足一手时卖全部）
    if (!pos || pos.qty <= 0) {
      blocked.push({ date, code: c.code, side: "sell", blockedBy: "无持仓可卖", reason: `${c.action} 但账上无持仓`, wantQty: 0 });
      continue;
    }
    let qty = pos.qty;
    if (c.action === "减仓") {
      qty = Math.floor(pos.qty / 2 / LOT) * LOT;
      if (qty < LOT) qty = pos.qty;
    }
    out.push({ decidedOn: date, code: c.code, account: c.account, side: "sell", limitPx: c.triggerPx, stopPx: c.stopPx, qty, thesis: c.thesis, action: c.action });
  }
  return out;
}

export function runBacktest(o: RunBacktestOptions): ReplayOutcome {
  const c = o.constraints ?? DEFAULT_CONSTRAINTS;
  const fillOpts = o.fill ?? DEFAULT_FILL_OPTIONS;
  const phase: Phase = o.phase ?? "盘后";
  const recovery = o.delistRecoveryRate ?? 1;

  // 交易日来自视图（日历真相源在数据层），回测层不自己算日历
  const calendar = o.viewFactory(o.to).tradingDays(o.from, o.to);

  const positions = new Map<string, ReplayPosition>();
  const equity: EquityPoint[] = [];
  const trades: ReplayTrade[] = [];
  const closed: ClosedTrade[] = [];
  const blocked: BlockedRecord[] = [];
  const skippedDays: string[] = [];
  const replayedDays: string[] = [];
  let droppedDecisions = 0;
  let delistLiquidations = 0;
  let cash = o.initialCash;
  let pending: ReplayDecision[] = [];

  const dayIndex = new Map<string, number>();

  for (const date of calendar) {
    const probe = o.viewFactory(date);
    // 1. 缺口日：跳过并计数。待执行决策一并丢弃 —— 顺延到后一天等于用了它当时不知道的行情
    if (probe.hasGap(date)) {
      skippedDays.push(date);
      droppedDecisions += pending.length;
      pending = [];
      continue;
    }
    const view = probe;
    replayedDays.push(date);
    dayIndex.set(date, replayedDays.length - 1);

    // 2. 执行昨日决策：先卖后买
    const ordered = [...pending].sort((a, b) => (a.side === b.side ? 0 : a.side === "sell" ? -1 : 1));
    for (const dec of ordered) {
      enforceNoLookAhead(dec.decidedOn, date);
      const m = marketStateOf(view, dec.code, date);
      const key = posKey(dec.account, dec.code);
      const pos = positions.get(key);

      let wantQty = dec.qty;
      if (dec.side === "sell") {
        if (!pos || pos.qty <= 0) {
          blocked.push({ date, code: dec.code, side: "sell", blockedBy: "无持仓可卖", reason: "成交日持仓已不存在", wantQty });
          continue;
        }
        const ok = sellableQty(pos, date, c);
        if (ok <= 0) {
          blocked.push({ date, code: dec.code, side: "sell", blockedBy: "T+1", reason: `建仓日 ${pos.openDate} 当日不可卖`, wantQty });
          continue;
        }
        wantQty = Math.min(wantQty, ok);
      } else if (m.bar) {
        // 买入先按可用现金削到买得起的手数，再去撮合。
        // 不能先撮合再削 —— 封板折算会被折两次
        const estPx = Math.min(dec.limitPx ?? m.bar.o, m.bar.o) * (1 + c.slippage);
        const affordable = Math.floor(cash / (estPx * (1 + c.feeRate)) / LOT) * LOT;
        if (affordable < LOT) {
          blocked.push({ date, code: dec.code, side: "buy", blockedBy: "资金不足", reason: `现金 ${cash.toFixed(2)} 买不起一手`, wantQty });
          continue;
        }
        wantQty = Math.min(wantQty, affordable);
      }

      const r = evaluateFill({ code: dec.code, side: dec.side, qty: wantQty, limitPx: dec.limitPx }, m, c, fillOpts);
      if (!r.filled) {
        blocked.push({ date, code: dec.code, side: dec.side, blockedBy: r.blockedBy!, reason: r.reason, wantQty });
        continue;
      }

      trades.push({ decidedOn: dec.decidedOn, filledOn: date, code: dec.code, account: dec.account, side: dec.side, px: r.px, qty: r.qty, fee: r.fee });

      if (dec.side === "buy") {
        cash -= r.notional + r.fee;
        const prevQty = pos?.qty ?? 0;
        const prevCost = pos?.cost ?? 0;
        const newQty = prevQty + r.qty;
        positions.set(key, {
          account: dec.account, code: dec.code, qty: newQty,
          // 均价成本含买入费用：卖出时算净盈亏就不用再回头找当初的手续费
          cost: (prevCost * prevQty + r.notional + r.fee) / newQty,
          // 加仓也刷新建仓日：T+1 对新买的那部分成立，整仓从严更安全
          openDate: date,
          stopPx: dec.stopPx ?? pos?.stopPx ?? null,
          thesis: dec.thesis || (pos?.thesis ?? ""),
          lastPx: m.bar ? m.bar.c : r.px,
        });
      } else {
        cash += r.notional - r.fee;
        const p = positions.get(key)!;
        closed.push({
          code: dec.code, account: dec.account,
          entryDate: p.openDate, exitDate: date,
          entryPx: p.cost, exitPx: r.px, qty: r.qty,
          pnl: (r.px - p.cost) * r.qty - r.fee,
          fees: r.fee,
          holdDays: (dayIndex.get(date) ?? 0) - (dayIndex.get(p.openDate) ?? 0),
        });
        const left = p.qty - r.qty;
        if (left <= 0) positions.delete(key);
        else positions.set(key, { ...p, qty: left });
      }
    }
    pending = [];

    // 3. 退市清算：掉出当日标的池的持仓不能挂在账上继续估值（spec §10.2）
    const inMarket = new Set(view.universe().map((s) => s.code));
    for (const [key, p] of [...positions]) {
      if (inMarket.has(p.code)) continue;
      const px = p.lastPx * recovery * (1 - c.slippage);
      const notional = px * p.qty;
      const fee = Math.max(c.minFee, notional * c.feeRate);
      cash += notional - fee;
      trades.push({ decidedOn: date, filledOn: date, code: p.code, account: p.account, side: "sell", px, qty: p.qty, fee });
      closed.push({
        code: p.code, account: p.account, entryDate: p.openDate, exitDate: date,
        entryPx: p.cost, exitPx: px, qty: p.qty,
        pnl: (px - p.cost) * p.qty - fee, fees: fee,
        holdDays: (dayIndex.get(date) ?? 0) - (dayIndex.get(p.openDate) ?? 0),
      });
      positions.delete(key);
      delistLiquidations++;
    }

    // 4. 按当日收盘估值。停牌（当日无 bar）沿用最后已知价，不当成 0
    let mv = 0;
    for (const p of positions.values()) {
      const bars = view.dailyBars(p.code, 1);
      const last: DailyBar | undefined = bars[bars.length - 1];
      if (last) p.lastPx = last.c;
      mv += p.qty * p.lastPx;
    }
    const total = cash + mv;
    equity.push({ date, equity: total, position: total > 0 ? mv / total : 0 });

    // 5. 最后才调策略。它只拿到当日视图，产出的决策挂到下一个可回放日
    const card = o.strategy({
      view, config: o.config, phase,
      positions: [...positions.values()].map((p) => ({
        account: p.account, code: p.code, cost: p.cost, qty: p.qty, stopPx: p.stopPx,
      })),
    });
    pending = decisionsFrom([...card.holdings, ...card.candidates], view, date, positions, total, blocked);
  }

  const unexecutedDecisions = pending.length;

  const detailed = computeMetricsDetailed({ equity, closed });
  const coverage = buildCoverageReport({
    requested: { from: o.from, to: o.to },
    tradingDays: calendar,
    replayedDays,
    skippedDays,
    lowConfidenceFactors: o.lowConfidenceFactors,
    adjFactorResolved: o.adjFactorResolved,
  });

  const metrics: BacktestMetrics = detailed.metrics;
  const report: BacktestReport = {
    strategyId: o.config.id,
    strategyVersion: o.config.version,
    config: o.config,
    range: { from: o.from, to: o.to },
    constraints: c,
    metrics,
    equity,
    coverage: {
      coverage: coverage.coverage,
      gapDays: coverage.gapDays,
      lowConfidenceFactors: coverage.lowConfidenceFactors,
      effectiveRange: coverage.effectiveRange,
    },
    // 哈希只覆盖输入与结果序列，不含 generatedAt（spec §17 断言 4）
    resultHash: computeResultHash({
      strategy: { id: o.config.id, version: o.config.version },
      config: o.config,
      range: { from: o.from, to: o.to },
      constraints: c,
      fill: fillOpts,
      initialCash: o.initialCash,
      phase,
      delistRecoveryRate: recovery,
      equity,
      trades,
      skippedDays,
    }),
  };

  return {
    report,
    detail: {
      trades, closed, blocked, skippedDays, replayedDays,
      droppedDecisions, unexecutedDecisions, delistLiquidations,
      coverage, degeneracy: detailed.degeneracy,
      generatedAt: o.generatedAt ?? null,
    },
  };
}
