import type {
  AccountType, Board, DailyBar, DtRow, Side, ZtRow,
} from "@/lib/contracts";

/**
 * 回测层内部类型。跨层共享的类型在 lib/contracts，这里只放回测自己用的。
 *
 * 放在单独文件是为了避免 replay ↔ metrics 循环 import：
 * metrics 要认识 ClosedTrade，replay 要调 metrics。
 */

/** 撮合意图。一笔意图 = 一个方向 + 一个限价（A股没有真市价单语义，一律带价） */
export interface FillIntent {
  code: string;
  side: Side;
  qty: number;
  /** 限价。null = 按当日开盘价挂单，仍受涨跌幅限制 */
  limitPx: number | null;
}

/** 撮合当日的市场状态。zt/dt 为 null 表示"没有真快照"，不等于"没涨停" */
export interface MarketState {
  date: string;
  code: string;
  board: Board;
  isSt: boolean;
  listDate: string | null;
  /** null = 当日无日线（停牌 / 未上市 / 已退市） */
  bar: DailyBar | null;
  prevClose: number | null;
  zt: ZtRow | null;
  dt: DtRow | null;
}

export type ConstraintName =
  | "停牌"
  | "T+1"
  | "涨停封板"
  | "跌停封板"
  | "涨跌幅越界"
  | "未触及限价"
  | "不足一手"
  | "资金不足"
  | "无持仓可卖"
  | "无价格基准";

export interface FillDecision {
  filled: boolean;
  /** 含滑点的成交价。未成交时为 0 */
  px: number;
  /** 实际成交量（可能是部分成交，已取整到一手） */
  qty: number;
  fee: number;
  /** px * qty，不含费 */
  notional: number;
  blockedBy: ConstraintName | null;
  reason: string;
  /** 封板场景下的成交概率，非封板场景为 1 */
  fillProb: number;
}

/** 昨日产出、今日执行的一条决策。decidedOn 必须早于成交日，否则就是未来函数 */
export interface ReplayDecision {
  decidedOn: string;
  code: string;
  account: AccountType;
  side: Side;
  /** 触发价。null = 次日开盘挂 */
  limitPx: number | null;
  stopPx: number | null;
  qty: number;
  thesis: string;
  /** 产生它的动作，用于复盘归因 */
  action: string;
}

export interface ReplayTrade {
  decidedOn: string;
  filledOn: string;
  code: string;
  account: AccountType;
  side: Side;
  px: number;
  qty: number;
  fee: number;
}

/** 一次完整往返。metrics 的胜率 / 盈亏比 / 持有天数都从这里算 */
export interface ClosedTrade {
  code: string;
  account: AccountType;
  entryDate: string;
  exitDate: string;
  /** 均价成本（含买入费用摊入） */
  entryPx: number;
  exitPx: number;
  qty: number;
  /** 净盈亏，已扣双边费用 */
  pnl: number;
  fees: number;
  /** 持有交易日数（按回测日序列算，不是自然日） */
  holdDays: number;
}

export interface BlockedRecord {
  date: string;
  code: string;
  side: Side;
  blockedBy: ConstraintName;
  reason: string;
  wantQty: number;
}

export interface ReplayPosition {
  account: AccountType;
  code: string;
  qty: number;
  /** 均价成本 */
  cost: number;
  openDate: string;
  stopPx: number | null;
  thesis: string;
  /** 最后一次已知收盘价，停牌日用它估值 */
  lastPx: number;
}
