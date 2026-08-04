import type { Board, Constraints, DailyBar, DtRow, ZtRow } from "@/lib/contracts";
import type { FillDecision, FillIntent, MarketState } from "@/lib/backtest/types";

/**
 * A股约束建模（spec §10.1）。默认全开（DEFAULT_CONSTRAINTS），关掉任何一条回测都会虚高。
 *
 * 这个文件的存在意义只有一条：**别让回测成交那些实盘根本成交不了的单**。
 * 其中最致命的是涨停封板买入 —— 策略最爱买的就是最强的票，而最强的票恰恰是买不进的那批。
 * 把买不进的板当买进了，回测曲线会漂亮得不像话，实盘一分钱赚不到。
 */

/** 一手 = 100 股。买入必须整手，卖出可以不足一手（零股只能一次性卖出） */
export const LOT = 100;

export interface FillOptions {
  /**
   * 封单额半概率点：封单额 / 当日成交额 = 该值时成交概率 0.5。
   * 取 0.10 的依据：实测封单额到成交额 10% 量级时排队基本无望排到，
   * 而 1~2% 的弱板经常能扫进去。这是量级判断，不是精确校准 —— 真快照攒够后
   * 可以用 zt_pool 的 seal_amt 与次日表现做后验校准（M5）。
   */
  sealHalfRatio: number;
  /** 炸板过（openTimes>=1）时的概率下限：封单被砸开过，限价单在开板瞬间能成交 */
  reopenedFloor: number;
  /** 概率低于此值直接判不成交 —— 低概率下按比例部分成交等于偷收益 */
  minFillProb: number;
}

export const DEFAULT_FILL_OPTIONS: FillOptions = {
  sealHalfRatio: 0.1,
  reopenedFloor: 0.85,
  minFillProb: 0.5,
};

/** spec §8.1 的分板阈值。ST 优先于主板/创业板，但北交所不适用 ST 5% */
export function limitBand(board: Board, isSt: boolean): number {
  if (board === "北交所") return 0.3;
  if (isSt) return 0.05;
  if (board === "创业板" || board === "科创板") return 0.2;
  return 0.1;
}

/** 代理判涨停用的 pct 阈值（spec §8.1 表）：留出零股与四舍五入的余量 */
function limitPctThreshold(board: Board, isSt: boolean): number {
  if (board === "北交所") return 0.297;
  if (isSt) return 0.048;
  if (board === "创业板" || board === "科创板") return 0.198;
  return 0.098;
}

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}

export function limitUpPx(prevClose: number, board: Board, isSt: boolean): number {
  return round2(prevClose * (1 + limitBand(board, isSt)));
}

export function limitDownPx(prevClose: number, board: Board, isSt: boolean): number {
  return round2(prevClose * (1 - limitBand(board, isSt)));
}

/** 上市首日无涨跌幅限制（spec §8.1：排除，不计入涨停家数） */
function isFirstDay(bar: DailyBar, listDate: string | null): boolean {
  return listDate !== null && bar.date === listDate;
}

/**
 * 日线代理判封板（spec §8.1）：pct 达阈值 **且** close == high。
 * 只判"收盘时是封着的"，判不出盘中炸过几次 —— 那需要分钟级历史，不可回补。
 */
export function isLimitUpBar(
  bar: DailyBar, prevClose: number | null, board: Board, isSt: boolean, listDate: string | null
): boolean {
  if (prevClose === null || prevClose <= 0) return false;
  if (isFirstDay(bar, listDate)) return false;
  const pct = (bar.c - prevClose) / prevClose;
  return pct >= limitPctThreshold(board, isSt) && bar.c === bar.h;
}

export function isLimitDownBar(
  bar: DailyBar, prevClose: number | null, board: Board, isSt: boolean, listDate: string | null
): boolean {
  if (prevClose === null || prevClose <= 0) return false;
  if (isFirstDay(bar, listDate)) return false;
  const pct = (bar.c - prevClose) / prevClose;
  return pct <= -limitPctThreshold(board, isSt) && bar.c === bar.l;
}

/**
 * 封板买入成交概率。
 *
 *   sealRatio = 封单额 / 当日成交额
 *   p = 1 / (1 + sealRatio / sealHalfRatio)
 *
 * 选这个形式的理由：
 *   1. 单调递减且落在 (0,1]，封单为 0 时 p=1，封单趋于无穷时 p→0，没有需要裁剪的病态区间；
 *   2. 只有一个可解释参数（半概率点），比多项式拟合更难过拟合；
 *   3. 用**比例**而不是绝对额：5 亿封单对茅台和对一只 3 亿成交的小票完全不是一回事。
 *
 * 关键的保守取舍：**拿不到封单额时返回 0**。涨停池是东财当日接口，不可回补
 * （README 坑 7），2026-08-03 之前的历史日期只有日线代理判出的"这天封板了"，没有封单额。
 * 那种日子一律判买不进。宁可漏掉真实存在的利润，也不能把买不进的板算成买进 ——
 * 前者让回测偏保守，后者让整份回测报告失效。
 */
export function limitUpFillProb(zt: ZtRow | null, bar: DailyBar, o: FillOptions): number {
  if (!zt || !Number.isFinite(zt.sealAmt)) return 0;
  const amount = bar.amount > 0 ? bar.amount : 1;
  const sealRatio = Math.max(0, zt.sealAmt) / amount;
  const p = 1 / (1 + sealRatio / o.sealHalfRatio);
  // 炸板过 = 封单曾被砸穿，挂在涨停价的限价单在开板那一刻会成交
  if (zt.openTimes >= 1) return Math.max(p, o.reopenedFloor);
  return p;
}

/** 跌停卖出概率，与封板买入同一函数形式：卖单排在跌停封单后面 */
export function limitDownFillProb(dt: DtRow | null, bar: DailyBar, o: FillOptions): number {
  if (!dt || !Number.isFinite(dt.sealAmt)) return 0;
  const amount = bar.amount > 0 ? bar.amount : 1;
  const sealRatio = Math.max(0, dt.sealAmt) / amount;
  return 1 / (1 + sealRatio / o.sealHalfRatio);
}

/** 双边费用：佣金+印花税+过户费近似为单一费率，两个方向都收，带最低佣金 */
export function roundFee(notional: number, c: Constraints): number {
  return Math.max(c.minFee, notional * c.feeRate);
}

/**
 * T+1（spec §10.1）：当日买入当日不可卖。
 *
 * 日频回测里这条天然满足（决策在 T 日收盘后产生，成交在 T+1，卖出决策最早在 T+1 收盘后），
 * 但检查必须留着 —— 一旦以后加了盘中相位或同日反手逻辑，少了它就会静默违规。
 */
export function sellableQty(
  pos: { qty: number; openDate: string }, execDate: string, c: Constraints
): number {
  if (c.t1 && pos.openDate >= execDate) return 0;
  return pos.qty;
}

function blocked(
  blockedBy: FillDecision["blockedBy"], reason: string, fillProb = 1
): FillDecision {
  return { filled: false, px: 0, qty: 0, fee: 0, notional: 0, blockedBy, reason, fillProb };
}

/**
 * 把一笔意图放进当日行情里撮合。顺序即优先级，改顺序会改结论：
 *   停牌 → 涨跌幅越界（交易所拒单） → 限价是否被触及 → 封板排队 → 一手取整 → 滑点与费用
 */
export function evaluateFill(
  intent: FillIntent, m: MarketState, c: Constraints, o: FillOptions = DEFAULT_FILL_OPTIONS
): FillDecision {
  const bar = m.bar;
  if (!bar) {
    // 无日线 = 停牌/未上市/已退市。suspensionBlocks 关掉也没价格可成交，只是换个理由
    return blocked("停牌", c.suspensionBlocks ? "当日无日线，停牌不成交" : "当日无日线，无价可成交");
  }
  if (intent.qty < LOT && intent.side === "buy") {
    return blocked("不足一手", `买入 ${intent.qty} 股不足一手`);
  }
  if (intent.qty <= 0) return blocked("不足一手", `数量 ${intent.qty}`);

  const band = limitBand(m.board, m.isSt);
  const firstDay = isFirstDay(bar, m.listDate);
  const up = m.prevClose !== null && !firstDay ? limitUpPx(m.prevClose, m.board, m.isSt) : Infinity;
  const dn = m.prevClose !== null && !firstDay ? limitDownPx(m.prevClose, m.board, m.isSt) : 0;

  // 挂单价越出涨跌幅限制 → 交易所直接拒单。ST 的 5% 带就是靠这一条生效
  const wantPx = intent.limitPx ?? bar.o;
  if (wantPx > up + 1e-9 || wantPx < dn - 1e-9) {
    return blocked(
      "涨跌幅越界",
      `限价 ${wantPx} 超出 ${m.isSt ? "ST " : ""}${m.board} ±${(band * 100).toFixed(0)}% 带 [${dn}, ${up}]`
    );
  }

  // 限价是否被触及。跳空到更有利的一侧时按开盘价成交
  let rawPx: number;
  if (intent.side === "buy") {
    if (bar.l > wantPx + 1e-9) return blocked("未触及限价", `最低 ${bar.l} > 限价 ${wantPx}`);
    rawPx = Math.min(wantPx, bar.o);
  } else {
    if (bar.h < wantPx - 1e-9) return blocked("未触及限价", `最高 ${bar.h} < 限价 ${wantPx}`);
    rawPx = Math.max(wantPx, bar.o);
  }

  // 封板排队：只有当成交价必须落在涨停价（买）/跌停价（卖）上时才排队。
  // 涨停当日盘中回落到限价的情形是能成交的，不该被这条误杀。
  let fillProb = 1;
  let qty = intent.qty;
  if (intent.side === "buy" && c.limitUpUnbuyable && rawPx >= up - 1e-9
      && isLimitUpBar(bar, m.prevClose, m.board, m.isSt, m.listDate)) {
    fillProb = limitUpFillProb(m.zt, bar, o);
    if (fillProb < o.minFillProb) {
      return blocked("涨停封板", `封板成交概率 ${fillProb.toFixed(3)} < ${o.minFillProb}`, fillProb);
    }
    qty = Math.floor((intent.qty * fillProb) / LOT) * LOT;
    if (qty < LOT) return blocked("涨停封板", `按概率 ${fillProb.toFixed(3)} 折算后不足一手`, fillProb);
  }
  if (intent.side === "sell" && c.limitDownUnsellable && rawPx <= dn + 1e-9
      && isLimitDownBar(bar, m.prevClose, m.board, m.isSt, m.listDate)) {
    fillProb = limitDownFillProb(m.dt, bar, o);
    if (fillProb < o.minFillProb) {
      return blocked("跌停封板", `跌停排队成交概率 ${fillProb.toFixed(3)} < ${o.minFillProb}`, fillProb);
    }
    qty = Math.floor((intent.qty * fillProb) / LOT) * LOT;
    if (qty < LOT) return blocked("跌停封板", `按概率 ${fillProb.toFixed(3)} 折算后不足一手`, fillProb);
  }

  // 滑点：买贵卖便宜，方向固定，不做随机（随机会破坏结果哈希可复现性，spec §17 断言 4）
  const px = intent.side === "buy" ? rawPx * (1 + c.slippage) : rawPx * (1 - c.slippage);
  const notional = px * qty;
  return { filled: true, px, qty, fee: roundFee(notional, c), notional, blockedBy: null, reason: "成交", fillProb };
}
