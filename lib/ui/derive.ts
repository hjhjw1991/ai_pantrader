import type { AccountType } from "@/lib/contracts/strategy";
import type { Position } from "@/lib/contracts/execution";
import type { ZtRow } from "@/lib/contracts/pit";

/**
 * 纯派生计算。不读 DB、不看时钟（"现在"一律从入参传）。
 *
 * 全部返回 `number | null`：算不出来就是 null，由渲染层显示破折号。
 * 这里绝不用 0 兜底 —— 一个假的 0 会被当成真实的平盘/零风险读。
 */

/** 数据不可用的统一表达。空态文案要说清"为什么没有"，不是干巴巴一句无数据 */
export interface Unavailable {
  available: false;
  /** 缺的是哪一层/哪张表，给人看 */
  reason: string;
  /** 补齐它需要什么 */
  needs?: string;
}

export type Avail<T> = ({ available: true } & T) | Unavailable;

export function unavailable(reason: string, needs?: string): Unavailable {
  return { available: false, reason, needs };
}

// ─────────────────────────── 观察池：距离触发价 ───────────────────────────

export interface TriggerDistance {
  /** 现价 - 触发价 */
  delta: number | null;
  /** (现价 - 触发价) / 触发价，小数 */
  deltaRatio: number | null;
  /** 现价是否已达到买点（触发价之下视为到位，因为我们做回踩低吸不追高） */
  reached: boolean;
}

/**
 * 距离买点。语义按"回踩低吸"定义：价格跌到触发价及以下才算到位。
 * 用户的交易风格是不打板、不追高（见投资目标），所以"突破触发"不是这里的语义。
 */
export function triggerDistance(
  price: number | null | undefined,
  triggerPx: number | null | undefined
): TriggerDistance {
  if (typeof price !== "number" || !Number.isFinite(price)) {
    return { delta: null, deltaRatio: null, reached: false };
  }
  if (typeof triggerPx !== "number" || !Number.isFinite(triggerPx) || triggerPx <= 0) {
    return { delta: null, deltaRatio: null, reached: false };
  }
  const delta = price - triggerPx;
  return { delta, deltaRatio: delta / triggerPx, reached: price <= triggerPx };
}

// ─────────────────────────── 持仓：浮盈亏 ───────────────────────────

export interface PositionPnl {
  marketValue: number | null;
  costValue: number;
  pnl: number | null;
  /** 浮动盈亏比例，小数 */
  pnlRatio: number | null;
}

export function positionPnl(
  p: Pick<Position, "cost" | "qty">,
  price: number | null | undefined
): PositionPnl {
  const costValue = p.cost * p.qty;
  if (typeof price !== "number" || !Number.isFinite(price)) {
    // 停牌 / 无快照：市值与浮盈亏都是未知，不能用成本价冒充现价
    return { marketValue: null, costValue, pnl: null, pnlRatio: null };
  }
  const marketValue = price * p.qty;
  const pnl = marketValue - costValue;
  return {
    marketValue,
    costValue,
    pnl,
    pnlRatio: costValue > 0 ? pnl / costValue : null,
  };
}

// ─────────────────────────── 持仓：硬线告警 ───────────────────────────

export type AlertLevel = "danger" | "warn";

export interface HardLineAlert {
  code: string;
  account: AccountType;
  level: AlertLevel;
  /** 触发了哪条线 */
  line: "止损" | "灾难位" | "止盈";
  message: string;
}

export interface AccountRules {
  /** 止损，负小数，如 -0.05 */
  止损?: number;
  /** 灾难位，负小数，如 -0.08。破了就不再等收盘确认 */
  灾难位?: number;
  /** 止盈档，正小数升序，如 [0.08, 0.15] */
  止盈?: number[];
}

/**
 * 硬线告警。规则来自 strategy.yaml 的 `持仓.<账户>` 段 —— 没有配置就不出告警，
 * 而不是套一个内置默认值：内置默认会让用户以为止损线是他设的那条。
 *
 * 账户语义可以完全不同（吃波动的按比例止损、扛逻辑的靠逻辑破坏），
 * 所以规则按账户分别传入，不做通用兜底。
 */
export function hardLineAlerts(
  rows: Array<{ position: Position; price: number | null; stopPx: number | null }>,
  rules: Partial<Record<AccountType, AccountRules>>
): HardLineAlert[] {
  const out: HardLineAlert[] = [];
  for (const { position, price, stopPx } of rows) {
    if (price === null || !Number.isFinite(price)) continue;
    const { pnlRatio } = positionPnl(position, price);
    const r = rules[position.account];

    // 逐票止损价优先于账户比例线：它是下单时就写死的那个数
    if (stopPx !== null && Number.isFinite(stopPx) && price <= stopPx) {
      out.push({
        code: position.code,
        account: position.account,
        level: "danger",
        line: "止损",
        message: `现价 ${price.toFixed(2)} 已破止损价 ${stopPx.toFixed(2)}`,
      });
    }
    if (pnlRatio === null || !r) continue;

    if (typeof r.灾难位 === "number" && pnlRatio <= r.灾难位) {
      out.push({
        code: position.code,
        account: position.account,
        level: "danger",
        line: "灾难位",
        message: `浮亏 ${(pnlRatio * 100).toFixed(1)}% 已破灾难位 ${(r.灾难位 * 100).toFixed(1)}%，不等收盘确认`,
      });
    } else if (typeof r.止损 === "number" && pnlRatio <= r.止损) {
      out.push({
        code: position.code,
        account: position.account,
        level: "warn",
        line: "止损",
        message: `浮亏 ${(pnlRatio * 100).toFixed(1)}% 已达止损线 ${(r.止损 * 100).toFixed(1)}%`,
      });
    }
    if (Array.isArray(r.止盈)) {
      const hit = [...r.止盈].filter((t) => typeof t === "number" && pnlRatio >= t).sort((a, b) => b - a)[0];
      if (hit !== undefined) {
        out.push({
          code: position.code,
          account: position.account,
          level: "warn",
          line: "止盈",
          message: `浮盈 ${(pnlRatio * 100).toFixed(1)}% 已过止盈档 ${(hit * 100).toFixed(1)}%`,
        });
      }
    }
  }
  return out;
}

// ─────────────────────────── 组合风控占比 ───────────────────────────

export interface PortfolioRisk {
  /** 各账户市值 */
  byAccount: Array<{ account: AccountType; marketValue: number | null; positions: number }>;
  /** 全部持仓市值合计。任一票无报价时为 null —— 缺一票的合计是错的合计 */
  totalMarketValue: number | null;
  /** 总仓位占比 = 持仓市值 / 账户总资产。总资产未记录时为 null */
  totalPositionRatio: number | null;
  /** 单票最大占比。分母是账户总资产，库里没有 → 恒为 null */
  maxSingleRatio: number | null;
  /**
   * 单票最大市值。**这个不需要分母，是能算出来的**。
   *
   * 补它是因为界面上那行标着"单票最大市值"却渲染 maxSingleRatio —— 一个恒 null 的比率，
   * 于是永远是空白。占比算不出来（没有总资产）是事实，但"最大那只值多少钱"是已知的，
   * 把已知的量也一起留空，等于让人误以为整块集中度信息都拿不到。
   */
  maxSingleMarketValue: number | null;
  maxSingleCode: string | null;
  /**
   * 单行业最大占比。**恒为 null**：库里没有行业分类字段
   * （security 只有 board = 主板/创业板/科创板/北交所，那是上市板不是行业；
   * sector 只在 zt_pool 里、且只覆盖当日涨停票）。
   * 不拿上市板冒充行业 —— 冒充出来的数字会被当成真实的行业集中度读。
   */
  maxIndustryRatio: null;
  /** 报价缺失的票，界面必须点名，不能静默从合计里漏掉 */
  missingQuoteCodes: string[];
}

export function portfolioRisk(
  rows: Array<{ position: Position; price: number | null }>,
  totalEquity: number | null
): PortfolioRisk {
  const byAccountMap = new Map<AccountType, { mv: number; n: number; missing: boolean }>();
  const missingQuoteCodes: string[] = [];
  let total = 0;
  let anyMissing = false;
  let maxMv = -1;
  let maxCode: string | null = null;

  for (const { position, price } of rows) {
    const acc = byAccountMap.get(position.account) ?? { mv: 0, n: 0, missing: false };
    acc.n += 1;
    if (price === null || !Number.isFinite(price)) {
      acc.missing = true;
      anyMissing = true;
      missingQuoteCodes.push(position.code);
    } else {
      const mv = price * position.qty;
      acc.mv += mv;
      total += mv;
      if (mv > maxMv) {
        maxMv = mv;
        maxCode = position.code;
      }
    }
    byAccountMap.set(position.account, acc);
  }

  const totalMarketValue = anyMissing ? null : total;
  const denom = totalEquity !== null && totalEquity > 0 ? totalEquity : null;

  return {
    byAccount: [...byAccountMap.entries()].map(([account, v]) => ({
      account,
      marketValue: v.missing ? null : v.mv,
      positions: v.n,
    })),
    totalMarketValue,
    totalPositionRatio: totalMarketValue !== null && denom ? totalMarketValue / denom : null,
    maxSingleRatio: maxMv >= 0 && denom ? maxMv / denom : null,
    maxSingleMarketValue: maxMv >= 0 ? maxMv : null,
    maxSingleCode: maxCode,
    maxIndustryRatio: null,
    missingQuoteCodes,
  };
}

// ─────────────────────────── 涨停池原始聚合 ───────────────────────────

export interface ZtStats {
  count: number;
  /** 连板数 -> 家数 */
  byLbc: Array<{ lbc: number; n: number }>;
  maxLbc: number | null;
  /** 连板梯队（lbc>=2），按连板数降序 */
  ladder: ZtRow[];
  /** 炸板次数合计。情绪转弱最直接的原始信号 */
  openTimesTotal: number;
  sealAmtMedian: number | null;
  /** 板块 -> 涨停家数，降序 */
  bySector: Array<{ sector: string; n: number }>;
}

/**
 * 涨停池的**原始聚合**，不是"龙头温度计因子"。
 *
 * 区别很重要：温度计因子（lib/factors, group=thermo）会做代理重建、带 confidence，
 * 这里只是把 zt_pool 表里已有的真值分组数一遍，没有任何建模。
 * 界面上必须照这个措辞标注，否则用户会以为因子层已经就绪。
 */
export function ztStats(rows: ZtRow[]): ZtStats {
  const byLbc = new Map<number, number>();
  const bySector = new Map<string, number>();
  const seals: number[] = [];
  let openTimesTotal = 0;

  for (const r of rows) {
    const lbc = Number.isFinite(r.lbc) ? r.lbc : 1;
    byLbc.set(lbc, (byLbc.get(lbc) ?? 0) + 1);
    if (r.sector) bySector.set(r.sector, (bySector.get(r.sector) ?? 0) + 1);
    if (Number.isFinite(r.sealAmt)) seals.push(r.sealAmt);
    if (Number.isFinite(r.openTimes)) openTimesTotal += r.openTimes;
  }

  seals.sort((a, b) => a - b);
  const median =
    seals.length === 0
      ? null
      : seals.length % 2
        ? seals[(seals.length - 1) / 2]
        : (seals[seals.length / 2 - 1] + seals[seals.length / 2]) / 2;

  return {
    count: rows.length,
    byLbc: [...byLbc.entries()].map(([lbc, n]) => ({ lbc, n })).sort((a, b) => b.lbc - a.lbc),
    maxLbc: rows.length ? Math.max(...rows.map((r) => (Number.isFinite(r.lbc) ? r.lbc : 1))) : null,
    ladder: rows.filter((r) => r.lbc >= 2).sort((a, b) => b.lbc - a.lbc || b.sealAmt - a.sealAmt),
    openTimesTotal,
    sealAmtMedian: median,
    bySector: [...bySector.entries()]
      .map(([sector, n]) => ({ sector, n }))
      .sort((a, b) => b.n - a.n),
  };
}

// ─────────────────────────── 源健康判定 ───────────────────────────

export type HealthVerdict = "ok" | "stale" | "failing" | "down";

/**
 * 源健康判定。免费非官方接口会掉线/限频，**静默陈旧是最危险的状态** ——
 * 页面上有数字但那是昨天的，用户照着下单。所以陈旧独立成一档，不并进 ok。
 */
export function healthVerdict(o: {
  lastOk: boolean;
  ageMinutes: number | null;
  okRate: number | null;
  staleAfterMinutes: number;
}): HealthVerdict {
  if (o.ageMinutes === null) return "down";
  if (o.ageMinutes > o.staleAfterMinutes) return "stale";
  if (!o.lastOk) return "down";
  if (o.okRate !== null && o.okRate < 0.8) return "failing";
  return "ok";
}
