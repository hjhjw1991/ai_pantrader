/**
 * 策略层测试替身。
 *
 * 两个都是替身，且都必须是替身：
 *   - PointInTimeView：策略层只依赖接口，真实现（lib/pit）掺进来只会让失败原因变模糊。
 *   - FactorRegistry：因子由另一个 agent 在写，引擎只能依赖注册表**接口**。
 *     这里的 FactorResult 全是手捏的，所以"引擎在这组因子读数下应该出什么动作"
 *     才是被测的东西。
 */
import type {
  DailyBar, FactorRegistry, FactorResult, FactorSpec, LhbRow, LhbSeatRow, MacroRow,
  MinuteBar, PointInTimeView, Quote, SectorRankRow, SecurityRow, StrategyConfig, ZtRow, DtRow,
  Board,
} from "@/lib/contracts";
import { parseStrategy } from "@/lib/strategy/loader";

/* --------------------------------- 视图 --------------------------------- */

export interface ViewFixture {
  asOf: string;
  bars?: Record<string, DailyBar[]>;
  quotes?: Record<string, Quote>;
  zt?: Record<string, ZtRow[]>;
  sectors?: Record<string, SectorRankRow[]>;
  lhb?: Record<string, LhbRow[]>;
  securities?: SecurityRow[];
  tradingDays?: string[];
  gaps?: Record<string, string[]>;
}

export function makeView(f: ViewFixture): PointInTimeView {
  const dateOf = (s: string) => s.slice(0, 10);
  const asOfDate = dateOf(f.asOf);
  const days = (f.tradingDays ?? []).filter(d => d <= asOfDate).sort();
  const bars = f.bars ?? {};

  return {
    asOf: f.asOf,
    dailyBars: (code, n) => {
      const all = (bars[code] ?? []).filter(b => b.date <= asOfDate);
      return n <= 0 ? [] : all.slice(Math.max(0, all.length - n));
    },
    minuteBars: (): MinuteBar[] => [],
    quote: code => (f.quotes ?? {})[code] ?? null,
    ztPool: date => (f.zt ?? {})[dateOf(date)] ?? [],
    dtPool: (): DtRow[] => [],
    sectorRank: date => (f.sectors ?? {})[dateOf(date)] ?? [],
    lhb: date => (f.lhb ?? {})[dateOf(date)] ?? [],
    lhbSeats: (): LhbSeatRow[] => [],
    macro: (): MacroRow[] => [],
    universe: () => (f.securities ?? []).filter(s =>
      (s.listDate === null || s.listDate <= asOfDate) &&
      (s.delistDate === null || s.delistDate > asOfDate)),
    security: code => (f.securities ?? []).find(s => s.code === code) ?? null,
    tradingDays: (from, to) => days.filter(d => d >= dateOf(from) && d <= dateOf(to)),
    prevTradingDay: (date, back = 1) => {
      const before = days.filter(d => d < dateOf(date));
      return before[before.length - back] ?? null;
    },
    hasGap: (date, kind) => {
      const ks = (f.gaps ?? {})[dateOf(date)];
      if (ks === undefined) return false;
      return kind === undefined ? ks.length > 0 : ks.includes(kind);
    },
  };
}

export function bar(code: string, date: string, c: number, over: Partial<DailyBar> = {}): DailyBar {
  return {
    code, date, o: over.o ?? c, h: over.h ?? c, l: over.l ?? c, c,
    vol: over.vol ?? 1e6, amount: over.amount ?? c * 1e6, adjFactor: over.adjFactor ?? 1,
  };
}

export function series(code: string, dates: string[], closes: number[]): DailyBar[] {
  return dates.map((d, i) => bar(code, d, closes[i]));
}

export function sec(code: string, board: Board, over: Partial<SecurityRow> = {}): SecurityRow {
  return {
    code, name: over.name ?? code, board,
    listDate: over.listDate ?? "2010-01-01",
    delistDate: over.delistDate ?? null,
    isStHistory: over.isStHistory ?? [],
  };
}

export function zt(date: string, code: string, over: Partial<ZtRow> = {}): ZtRow {
  return {
    date, code, lbc: over.lbc ?? 1, sealAmt: over.sealAmt ?? 1e8,
    openTimes: over.openTimes ?? 0, firstSealTs: null, lastSealTs: null,
    sector: over.sector ?? null,
  };
}

export function quote(code: string, price: number, over: Partial<Quote> = {}): Quote {
  return {
    code, ts: over.ts ?? "2026-08-03 14:55:00", price,
    pct: over.pct ?? 0, turnover: over.turnover ?? 5, amplitude: over.amplitude ?? 4,
  };
}

/* ------------------------------- 因子注册表 ------------------------------- */

/** 一个因子的桩：可以给固定读数，也可以按 params.code 分别给 */
export type StubValue =
  | Partial<FactorResult<any>>
  | ((params: Record<string, unknown>) => Partial<FactorResult<any>>);

export function stubRegistry(stubs: Record<string, StubValue>): FactorRegistry {
  const specs = new Map<string, FactorSpec<any>>();
  for (const [name, stub] of Object.entries(stubs)) {
    specs.set(name, {
      name, version: "1.0.0", group: "env", defaults: {},
      fn: ctx => {
        const partial = typeof stub === "function" ? stub(ctx.params) : stub;
        return {
          name, version: "1.0.0",
          value: partial.value === undefined ? 0 : partial.value,
          label: partial.label,
          provenance: partial.provenance ?? "real",
          confidence: partial.confidence ?? 1,
          inputs: partial.inputs,
        };
      },
    });
  }
  return {
    register: spec => { specs.set(spec.name, spec); },
    get: name => specs.get(name),
    list: () => [...specs.values()].sort((a, b) => (a.name < b.name ? -1 : 1)),
    lock: () => {
      const out: Record<string, string> = {};
      for (const s of [...specs.values()].sort((a, b) => (a.name < b.name ? -1 : 1))) {
        out[s.name] = s.version;
      }
      return out;
    },
  };
}

/* --------------------------------- 配置 --------------------------------- */

export const BASE_YAML = `id: t
version: 1.0.0
择时:
  仓位档位:  { 进攻: 0.7, 中性: 0.4, 防守: 0.0 }
  防守触发:  { 跌停家数>: 30, 权重杀跌: true, 外围risk_off: true }
选股:
  过滤器阈值: { 位置涨幅上限: 50, 换手上限: 15, 振幅上限: 10 }
  主线识别:  { 板块涨幅榜TopN: 3, 必查链: [半导体全链, 军工, 电网, 资源] }
持仓:
  卫星账户:  { 可交易板块: [主板], 仓位桶: 卫星, 止损: -0.05, 灾难位: -0.08, 止损确认: 收盘, 止盈: [0.08减半, 0.15清] }
  核心账户:  { 可交易板块: [主板, 创业板, 科创板], 仓位桶: 核心, 止损: 逻辑破坏, 加仓: 逆势分批 }
组合风控:
  总仓位上限: 0.8
  单票最大占比: 0.15
  单行业最大占比: 0.35
  核心卫星比例: { 核心: 0.6, 卫星: 0.4 }
`;

export function config(mutate: (yaml: string) => string = s => s): StrategyConfig {
  return parseStrategy(mutate(BASE_YAML)).config;
}
