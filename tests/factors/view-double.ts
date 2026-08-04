/**
 * PointInTimeView 的测试替身。
 *
 * 为什么不用 SQLite 视图：PointInTimeView 只是个接口，因子层的单测要的是
 * "给定这组数字，因子输出什么"，掺进真实存储只会让失败原因变模糊。
 * 真实实现由 lib/pit 那边负责，两边靠同一个接口对齐。
 */
import type {
  PointInTimeView, DailyBar, MinuteBar, Quote, ZtRow, DtRow,
  SectorRankRow, LhbRow, LhbSeatRow, MacroRow, SecurityRow, Board,
} from "@/lib/contracts";

export interface ViewFixture {
  asOf: string;
  /** code -> 日线（升序） */
  bars?: Record<string, DailyBar[]>;
  /** `${code}:${period}` -> 分钟线 */
  minutes?: Record<string, MinuteBar[]>;
  quotes?: Record<string, Quote>;
  zt?: Record<string, ZtRow[]>;
  dt?: Record<string, DtRow[]>;
  sectors?: Record<string, SectorRankRow[]>;
  lhb?: Record<string, LhbRow[]>;
  seats?: Record<string, LhbSeatRow[]>;
  macro?: Record<string, MacroRow[]>;
  securities?: SecurityRow[];
  /** 不给就从所有日线日期推 */
  tradingDays?: string[];
  /** date -> kind[] */
  gaps?: Record<string, string[]>;
}

export function makeView(f: ViewFixture): PointInTimeView {
  const bars = f.bars ?? {};
  const securities = f.securities ?? [];

  const derivedDays = (): string[] => {
    const s = new Set<string>();
    for (const arr of Object.values(bars)) for (const b of arr) s.add(b.date);
    for (const d of Object.keys(f.zt ?? {})) s.add(d);
    for (const d of Object.keys(f.lhb ?? {})) s.add(d);
    return [...s].sort();
  };
  const days = (f.tradingDays ?? derivedDays()).filter(d => d <= f.asOf).sort();

  return {
    asOf: f.asOf,

    dailyBars(code, n) {
      const all = (bars[code] ?? []).filter(b => b.date <= f.asOf);
      return all.slice(Math.max(0, all.length - n));
    },
    minuteBars(code, period, n) {
      const all = (f.minutes ?? {})[`${code}:${period}`] ?? [];
      return all.slice(Math.max(0, all.length - n));
    },
    quote(code) {
      return (f.quotes ?? {})[code] ?? null;
    },

    ztPool(date) { return (f.zt ?? {})[date] ?? []; },
    dtPool(date) { return (f.dt ?? {})[date] ?? []; },
    sectorRank(date) { return (f.sectors ?? {})[date] ?? []; },
    lhb(date) { return (f.lhb ?? {})[date] ?? []; },
    lhbSeats(date) { return (f.seats ?? {})[date] ?? []; },
    macro(symbol, n) {
      const all = (f.macro ?? {})[symbol] ?? [];
      return all.slice(Math.max(0, all.length - n));
    },

    universe() {
      return securities.filter(s =>
        (s.listDate === null || s.listDate <= f.asOf) &&
        (s.delistDate === null || s.delistDate > f.asOf));
    },
    security(code) { return securities.find(s => s.code === code) ?? null; },

    tradingDays(from, to) { return days.filter(d => d >= from && d <= to); },
    prevTradingDay(date, back = 1) {
      const before = days.filter(d => d < date);
      return before[before.length - back] ?? null;
    },

    hasGap(date, kind) {
      const ks = (f.gaps ?? {})[date];
      if (!ks) return false;
      return kind === undefined ? ks.length > 0 : ks.includes(kind);
    },
  };
}

/* ------------------------------ 构造小工具 ------------------------------ */

/** 连续 n 个工作日（不查真实节假日，测试里只需要"有序且唯一"） */
export function weekdays(start: string, n: number): string[] {
  const out: string[] = [];
  const d = new Date(start + "T00:00:00Z");
  while (out.length < n) {
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

const r2 = (x: number) => Math.round(x * 100) / 100;

/** 默认收盘不等于最高，避免测试里"不小心"造出一堆封板 */
export function bar(code: string, date: string, c: number, opt: Partial<DailyBar> = {}): DailyBar {
  const o = opt.o ?? c;
  return {
    code, date,
    o, h: opt.h ?? r2(Math.max(o, c) * 1.005), l: opt.l ?? r2(Math.min(o, c) * 0.995), c,
    vol: opt.vol ?? 1e6, amount: opt.amount ?? c * 1e6, adjFactor: opt.adjFactor ?? 1,
    ...opt,
  };
}

/** 一字/T字封板：收盘 == 最高 */
export function sealedBar(code: string, date: string, prevClose: number, pct: number, opt: Partial<DailyBar> = {}): DailyBar {
  const c = r2(prevClose * (1 + pct / 100));
  return bar(code, date, c, { h: c, l: opt.l ?? r2(c * 0.98), ...opt });
}

export function seriesFrom(
  code: string, ds: string[], closes: number[], opt: { vol?: number[] } = {}
): DailyBar[] {
  return ds.map((d, i) => bar(code, d, closes[i], {
    o: i === 0 ? closes[0] : closes[i - 1],
    vol: opt.vol?.[i] ?? 1e6,
  }));
}

export function sec(
  code: string, board: Board, opt: Partial<SecurityRow> = {}
): SecurityRow {
  return {
    code, name: opt.name ?? code, board,
    listDate: opt.listDate ?? "2010-01-01",
    delistDate: opt.delistDate ?? null,
    isStHistory: opt.isStHistory ?? [],
  };
}

export function lhbRow(
  date: string, code: string, changeType: string, netAmt: number, opt: Partial<LhbRow> = {}
): LhbRow {
  return {
    date, code, changeType, name: opt.name ?? code,
    explanation: opt.explanation ?? "日涨幅偏离值达到7%的前5只证券",
    explainStat: opt.explainStat ?? "",
    netAmt,
    buyAmt: opt.buyAmt ?? Math.max(netAmt, 0),
    sellAmt: opt.sellAmt ?? Math.max(-netAmt, 0),
    turnoverRate: opt.turnoverRate ?? null,
    dealAmountRatio: opt.dealAmountRatio ?? null,
    closePrice: opt.closePrice ?? null,
    changeRate: opt.changeRate ?? null,
    d1Chg: opt.d1Chg ?? null, d5Chg: opt.d5Chg ?? null, d10Chg: opt.d10Chg ?? null,
    d20Chg: opt.d20Chg ?? null, d30Chg: opt.d30Chg ?? null,
  };
}

export function seatRow(
  date: string, code: string, deptName: string, netAmt: number, opt: Partial<LhbSeatRow> = {}
): LhbSeatRow {
  return {
    date, code,
    changeType: opt.changeType ?? "1",
    side: opt.side ?? (netAmt >= 0 ? "buy" : "sell"),
    deptCode: opt.deptCode ?? "0",
    deptName,
    buyAmt: opt.buyAmt ?? Math.max(netAmt, 0),
    sellAmt: opt.sellAmt ?? Math.max(-netAmt, 0),
    netAmt,
    riseProb3d: opt.riseProb3d ?? null,
    buyerTimes3d: opt.buyerTimes3d ?? null,
    ...opt,
  };
}

export function ztRow(date: string, code: string, opt: Partial<ZtRow> = {}): ZtRow {
  return {
    date, code,
    lbc: opt.lbc ?? 1,
    sealAmt: opt.sealAmt ?? 1e8,
    openTimes: opt.openTimes ?? 0,
    firstSealTs: opt.firstSealTs ?? null,
    lastSealTs: opt.lastSealTs ?? null,
    sector: opt.sector ?? null,
  };
}

export function quote(code: string, opt: Partial<Quote> = {}): Quote {
  return {
    code, ts: opt.ts ?? "2026-08-03 15:00:00",
    price: opt.price ?? 10, pct: opt.pct ?? 0,
    turnover: opt.turnover ?? 5, amplitude: opt.amplitude ?? 4,
  };
}
