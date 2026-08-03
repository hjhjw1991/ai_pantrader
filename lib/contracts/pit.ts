/**
 * PointInTimeView —— 因子层与策略层唯一的数据入口。
 *
 * 为什么不让它们直接读 DB：
 *   1. 防未来函数。视图带 asOf，实现负责保证"只返回 asOf 及之前的数据"。
 *      策略里写一句 SELECT ... ORDER BY date DESC LIMIT 1 就能悄悄用到未来数据，
 *      回测漂亮、实盘归零，这类 bug 几乎抓不出来，所以从架构上禁掉。
 *   2. 回测与实盘同一份策略代码：回测喂历史视图，实盘喂当日视图。
 *
 * spec §17 有一条 CI 断言：`grep -rE "\bdb\.|prisma\.|sqlite" lib/factors/ lib/strategy/` 必须零命中。
 * 因子层还有一条：不许出现 fetch / axios / Date.now。当前时间从 view.asOf 拿。
 */

export interface DailyBar {
  code: string; date: string;
  o: number; h: number; l: number; c: number;
  vol: number; amount: number;
  /** 复权因子。spec R1：2022-05~2023-12 无复权参照，该区间可能为 1，读的人要知道 */
  adjFactor: number;
}

export interface MinuteBar {
  code: string; ts: string; period: number;
  o: number; h: number; l: number; c: number; vol: number;
}

export interface Quote {
  code: string; ts: string;
  price: number; pct: number;
  turnover: number; amplitude: number;
}

export interface ZtRow {
  date: string; code: string;
  /** 连板数 */
  lbc: number;
  /** 封单额 */
  sealAmt: number;
  /** 炸板次数 */
  openTimes: number;
  firstSealTs: string | null;
  lastSealTs: string | null;
  sector: string | null;
}

export interface DtRow { date: string; code: string; sealAmt: number }

export interface SectorRankRow {
  date: string; ts: string; sector: string; pct: number; leaderCode: string | null;
}

/** 龙虎榜一行 = 一只票的一个上榜原因。同票同日可有多行，别按 code 去重。 */
export interface LhbRow {
  date: string; code: string; changeType: string; name: string;
  explanation: string; explainStat: string;
  netAmt: number; buyAmt: number; sellAmt: number;
  turnoverRate: number | null; dealAmountRatio: number | null;
  closePrice: number | null; changeRate: number | null;
  /** 上榜当日为 null，随时间回填。当监督标签用时必须判 null。 */
  d1Chg: number | null; d5Chg: number | null; d10Chg: number | null;
  d20Chg: number | null; d30Chg: number | null;
}

/** 营业部席位明细，游资识别的原料。 */
export interface LhbSeatRow {
  date: string; code: string; changeType: string;
  side: "buy" | "sell";
  deptCode: string; deptName: string;
  buyAmt: number; sellAmt: number; netAmt: number;
  /** 该席位近 3 日买入后上涨概率 */
  riseProb3d: number | null;
  buyerTimes3d: number | null;
}

/** 外围市场：A50 / 费半 / 金油等。上线起攒，没有历史。 */
export interface MacroRow { ts: string; symbol: string; price: number; pct: number }

export type Board = "主板" | "创业板" | "科创板" | "北交所";

export interface SecurityRow {
  code: string; name: string;
  listDate: string | null; delistDate: string | null;
  board: Board;
  /** ST 状态随时间变化，回溯判断必须查这个，不能用当前状态 */
  isStHistory: Array<{ from: string; to: string | null }>;
}

export interface PointInTimeView {
  /** 视图时点。因子层取"现在"只能用它，不许 Date.now() */
  readonly asOf: string;

  /** code 最近 n 根日线，升序，最后一根不晚于 asOf */
  dailyBars(code: string, n: number): DailyBar[];
  minuteBars(code: string, period: number, n: number): MinuteBar[];
  /** asOf 时点最新快照；无数据返回 null（停牌/未上市），不许返回 0 价 */
  quote(code: string): Quote | null;

  ztPool(date: string): ZtRow[];
  dtPool(date: string): DtRow[];
  sectorRank(date: string): SectorRankRow[];
  lhb(date: string): LhbRow[];
  lhbSeats(date: string): LhbSeatRow[];
  /** 外围市场最近 n 条。上线前无数据，因子要能接受空数组并降 confidence */
  macro(symbol: string, n: number): MacroRow[];

  /**
   * 当日在市标的池。必须按 listDate/delistDate 过滤 —— spec §10.2：
   * 用当前在市清单回测 2022 年等于假装当年买的没一只退市，收益被系统性高估。
   */
  universe(): SecurityRow[];
  security(code: string): SecurityRow | null;

  /** asOf 及之前的交易日，升序 */
  tradingDays(from: string, to: string): string[];
  prevTradingDay(date: string, back?: number): string | null;

  /** 该日是否有已知数据缺口。回测遇到必须跳过并计入覆盖率（spec §10.5） */
  hasGap(date: string, kind?: string): boolean;
}
