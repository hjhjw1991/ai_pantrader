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

  /**
   * code 最近 n 根日线，升序，最后一根不晚于 asOf。**原始价，不复权。**
   *
   * 触发价、止损价、涨跌停判定一律用它 —— 那些价格要挂进券商，
   * 必须是市场上真实存在的数字。技术指标请改用 adjBars。
   */
  dailyBars(code: string, n: number): DailyBar[];
  /**
   * 同 dailyBars，但 OHLC 已乘上当日复权因子（**后复权**）。成交量不乘。
   *
   * 为什么是独立方法而不是让调用方自己乘 adjFactor：让每个消费方各自决定，
   * 漏一处就是静默的错 —— 而"某个指标悄悄跑在未复权价上"这种错，
   * 表现只是结论偶尔怪怪的，几乎不可能被发现。分成两个方法，调用点即声明。
   */
  adjBars(code: string, n: number): DailyBar[];
  /**
   * 周线 / 月线，升序，**后复权**。由复权日线本地聚合而来（见 016 迁移的说明）。
   * 没有数据返回空数组：新股与长期停牌票天然没有。
   */
  periodBars(code: string, period: "W" | "M", n: number): DailyBar[];
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

  /**
   * asOf 那天这只票属于哪个申万行业。查不到返回 null。
   *
   * **返回 null 的情况必须当成"不知道"，不能当成"不在主线上"**：
   * 74.6% 的票 beginningdate 压在 2021-12-13（2021 版基期），在那之前
   * 申万这套分类根本不存在，硬给一个行业等于用今天的定义解释历史。
   */
  industryAt(code: string, level: 1 | 3): { indexCode: string; indexName: string } | null;
  /**
   * 不晚于 asOf 的最近一条估值。**带上它的日期**，调用方要能判断新鲜度 ——
   * 数据源只给当日快照，接入之前一片空白，中间也可能有缺口。
   *
   * pe 为负是亏损，是真实读数，不是缺数据。
   */
  valuation(code: string): {
    date: string; pe: number | null; pb: number | null;
    mktcap: number | null; floatMktcap: number | null;
  } | null;

  /**
   * [asOf, asOf + days] 内的限售解禁，**含当天**（解禁日当天抛压就在眼前）。
   *
   * 解禁日在发行时就定了，所以这份日历对回测基本可用；残余前视只来自
   * "评估日之后才完成的定增"，其解禁日离评估日至少半年，很少落进短窗口。
   */
  liftsAhead(code: string, days: number): Array<{
    date: string; freeRatio: number | null; liftMktcap: number | null; shareType: string;
  }>;
  /**
   * 执行窗口与 [asOf, asOf + days] 有交集的**减持**计划（不含增持）。
   *
   * 只返回 first_seen <= asOf 的 —— 我们还没看到的计划不能拿来判断，
   * 否则就是未来函数。代价是这份数据从接入那天才开始有（源只保留最近约 2 条）。
   */
  reductionPlans(code: string, days: number): Array<{
    actor: string; startDate: string; endDate: string;
    maxRatio: number | null; maxShares: number | null; firstSeen: string;
  }>;

  /** 该日是否有已知数据缺口。回测遇到必须跳过并计入覆盖率（spec §10.5） */
  hasGap(date: string, kind?: string): boolean;
}
