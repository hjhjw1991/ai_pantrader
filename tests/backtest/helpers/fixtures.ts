import type {
  Board, Candidate, DailyBar, DtRow, EnvAssessment, LhbRow, LhbSeatRow, MacroRow, MinuteBar,
  PointInTimeView, Phase, Quote, SectorRankRow, SecurityRow, SignalCard, StrategyConfig, ZtRow,
} from "@/lib/contracts";

/**
 * 回测测试用的 PointInTimeView 替身。
 *
 * 为什么自己造而不 import lib/pit：回测层对 PIT 只依赖契约，实现由别的 agent 在写。
 * 更重要的是这个替身必须**严格截断 asOf 之后的数据** —— 它是 look-ahead 测试的裁判，
 * 如果替身自己漏未来数据，那条测试就永远不会红。
 */

export interface FixtureData {
  tradingDays: string[];
  /** code -> 升序日线 */
  bars: Record<string, DailyBar[]>;
  securities: SecurityRow[];
  /** date -> 当日涨停池 */
  zt?: Record<string, ZtRow[]>;
  dt?: Record<string, DtRow[]>;
  /** date -> 缺口 kind 列表。回测遇到必须跳过（spec §10.5） */
  gaps?: Record<string, string[]>;
}

export function makeBar(
  code: string, date: string, o: number, h: number, l: number, c: number,
  vol = 1_000_000, amount = 1_000_000 * c, adjFactor = 1
): DailyBar {
  return { code, date, o, h, l, c, vol, amount, adjFactor };
}

/** 从收盘价序列造日线：o/h/l 按给定偏移生成，够测试用，数值可预测 */
export function barsFromCloses(
  code: string, dates: string[], closes: number[],
  shape: (c: number, i: number) => { o: number; h: number; l: number } =
    (c) => ({ o: c, h: c, l: c })
): DailyBar[] {
  return dates.map((d, i) => {
    const c = closes[i];
    const s = shape(c, i);
    return makeBar(code, d, s.o, s.h, s.l, c);
  });
}

export function makeSecurity(
  code: string, name = code, board: Board = "主板",
  opts: { listDate?: string | null; delistDate?: string | null; st?: Array<{ from: string; to: string | null }> } = {}
): SecurityRow {
  return {
    code, name, board,
    listDate: opts.listDate ?? "2015-01-01",
    delistDate: opts.delistDate ?? null,
    isStHistory: opts.st ?? [],
  };
}

/** 生成连续的假交易日（不查真日历，测试只要单调递增且可预测） */
export function fakeTradingDays(from: string, n: number): string[] {
  const out: string[] = [];
  const d = new Date(`${from}T00:00:00Z`);
  while (out.length < n) {
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

export function makeViewFactory(data: FixtureData): (asOf: string) => PointInTimeView {
  return (asOf: string) => new FixtureView(data, asOf);
}

class FixtureView implements PointInTimeView {
  constructor(private readonly d: FixtureData, readonly asOf: string) {}

  dailyBars(code: string, n: number): DailyBar[] {
    const all = this.d.bars[code] ?? [];
    // 截断是这个替身唯一的核心职责：晚于 asOf 的一根都不能漏出去
    const upto = all.filter((b) => b.date <= this.asOf);
    return upto.slice(Math.max(0, upto.length - n));
  }

  minuteBars(_code: string, _period: number, _n: number): MinuteBar[] {
    return [];
  }

  quote(code: string): Quote | null {
    const bars = this.dailyBars(code, 2);
    const last = bars[bars.length - 1];
    if (!last || last.date !== this.asOf) return null; // 停牌/未上市：不许返回 0 价
    const prev = bars.length > 1 ? bars[bars.length - 2].c : last.c;
    return {
      code, ts: `${this.asOf}T15:00:00+08:00`, price: last.c,
      pct: prev === 0 ? 0 : (last.c - prev) / prev,
      turnover: 0, amplitude: last.l === 0 ? 0 : (last.h - last.l) / last.l,
    };
  }

  private guard(date: string): void {
    if (date > this.asOf) throw new Error(`未来函数：asOf=${this.asOf} 请求了 ${date}`);
  }

  ztPool(date: string): ZtRow[] { this.guard(date); return this.d.zt?.[date] ?? []; }
  dtPool(date: string): DtRow[] { this.guard(date); return this.d.dt?.[date] ?? []; }
  sectorRank(date: string): SectorRankRow[] { this.guard(date); return []; }
  lhb(date: string): LhbRow[] { this.guard(date); return []; }
  lhbSeats(date: string): LhbSeatRow[] { this.guard(date); return []; }
  macro(_symbol: string, _n: number): MacroRow[] { return []; }

  universe(): SecurityRow[] {
    // spec §10.2：按当日在市过滤。用当前清单回测历史等于假装没票退市
    return this.d.securities.filter(
      (s) => (!s.listDate || s.listDate <= this.asOf) && (!s.delistDate || s.delistDate > this.asOf)
    );
  }

  security(code: string): SecurityRow | null {
    return this.d.securities.find((s) => s.code === code) ?? null;
  }

  tradingDays(from: string, to: string): string[] {
    const hi = to < this.asOf ? to : this.asOf;
    return this.d.tradingDays.filter((x) => x >= from && x <= hi);
  }

  prevTradingDay(date: string, back = 1): string | null {
    const idx = this.d.tradingDays.indexOf(date);
    if (idx < 0) return null;
    const t = idx - back;
    return t >= 0 ? this.d.tradingDays[t] : null;
  }

  hasGap(date: string, kind?: string): boolean {
    const kinds = this.d.gaps?.[date];
    if (!kinds) return false;
    return kind ? kinds.includes(kind) : kinds.length > 0;
  }
}

/** 最小可用策略配置。回测只用到 id/version（进哈希）与 组合风控 的上限 */
export function makeConfig(over: Partial<StrategyConfig> = {}): StrategyConfig {
  return {
    id: "test-strat",
    version: "1.0.0",
    择时: { 仓位档位: { 进攻: 0.8, 中性: 0.5, 防守: 0 }, 防守触发: {} },
    选股: { 过滤器阈值: {}, 主线识别: { 板块涨幅榜TopN: 5, 必查链: ["半导体"] } },
    持仓: { 卫星: {}, 核心: {} },
    组合风控: {
      总仓位上限: 1, 单票最大占比: 1, 单行业最大占比: 1,
      核心卫星比例: { 核心: 0.6, 卫星: 0.4 },
    },
    ...over,
  };
}

const NEUTRAL_ENV: EnvAssessment = {
  gear: "中性", targetPosition: 0.5, reasons: ["测试"], factors: [], lowConfidenceFactors: [],
};

export function makeCandidate(over: Partial<Candidate> & { code: string }): Candidate {
  return {
    name: over.code, action: "买入", account: "卫星", triggerPx: null, stopPx: null,
    size: 0.5, thesis: "测试逻辑", passedFilters: [], factors: [], score: 1,
    ...over,
  };
}

export function makeCard(
  ts: string, candidates: Candidate[], holdings: Candidate[] = [], phase: Phase = "盘后"
): SignalCard {
  return {
    ts, phase, strategyId: "test-strat", env: NEUTRAL_ENV,
    candidates, holdings, warnings: [], advisorInfluenced: false,
  };
}
