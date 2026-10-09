import type Database from "better-sqlite3";
import type { Quote } from "@/lib/contracts/pit";
import type { StrategyConfig } from "@/lib/contracts/strategy";
import {
  hardLineAlerts,
  portfolioRisk,
  positionPnl,
  triggerDistance,
  type AccountRules,
  type HardLineAlert,
  type PortfolioRisk,
  type PositionPnl,
  type TriggerDistance,
} from "@/lib/ui/derive";
import {
  accounts,
  latestQuotes,
  positions,
  securities,
  watchpool,
  type AccountRow,
  type PositionRow,
  type WatchpoolRow,
} from "@/lib/ui/queries";
import { accountRules } from "@/lib/ui/adapters/strategy";
import { intradayMood, type IntradayMood } from "@/lib/sentiment/intraday";

/**
 * 页面级视图组装。持仓与观察池被三个页面共用（作战台/持仓/观察池），
 * 组装逻辑放一处，免得三份实现里有一份把浮盈亏算反。
 */

type Db = Database.Database;

export interface PositionView {
  position: PositionRow;
  name: string | null;
  quote: Quote | null;
  pnl: PositionPnl;
  /** 现价距止损价还有多远（负数 = 已破） */
  stopGapRatio: number | null;
  /** 今日涨幅减去全市场平均涨幅（百分点）。正 = 跑赢。null = 无快照或无市场基准 */
  vsMarket: number | null;
}

/**
 * 个股相对强度 = 个股涨幅 − 全市场平均涨幅。
 *
 * 为什么要减掉市场：市场 −3% 时个股 −1% 是**强势**，可光看个股是绿的；
 * 市场 +3% 时个股 +1% 是**弱势**，光看个股是红的。持仓要不要动，
 * 判断依据是"它比市场强还是弱"，不是"它今天是红是绿"。
 *
 * 用平均涨幅而不是指数涨幅：库里没有指数序列（日线采集只拉 6 位代码），
 * 而 quote_snapshot 是全市场 5887 只，直接算得出均值，不需要额外数据源。
 */
export function relStrength(
  q: Pick<Quote, "ts" | "pct"> | null | undefined,
  market: { ts: string; avgPct: number } | null | undefined,
): number | null {
  if (!q || !market) return null;
  const pct = q.pct;
  if (pct === null || pct === undefined || !Number.isFinite(pct)) return null;
  /**
   * 必须是同一个交易日。latestQuotes 取的是**逐票**最新快照：停牌票今天没有快照，
   * 拿到的是昨天（甚至更早）那根 —— 用昨天的涨幅去减今天的市场均值，
   * 会凭空算出"跑赢/跑输"。日期对不上就如实给 null。
   */
  if (!q.ts || !market.ts || q.ts.slice(0, 10) !== market.ts.slice(0, 10)) return null;
  return pct - market.avgPct;
}

export interface PositionsView {
  rows: PositionView[];
  accounts: AccountRow[];
  alerts: HardLineAlert[];
  risk: PortfolioRisk;
  /** 盘中情绪。null = 今天没有快照（休市 / 还没开盘） */
  mood: IntradayMood | null;
  /** 有 position 行但 account 表查不到对应账户 —— 会导致止损规则套错，必须点名 */
  orphanAccountIds: string[];
  /** YAML 里配了规则、但 account 表里没有的账户名 */
  rulesWithoutAccount: string[];
  /**
   * **确实从 YAML 拿到了规则**的账户 id。
   *
   * 为什么必须单列：持仓页原先用 `rulesFromConfig && !rulesWithoutAccount.includes(acc)`
   * 判断某账户有没有规则 —— 那个式子问的是"YAML 里有没有任何规则"和
   * "YAML 的规则键是不是都存在于 account 表"，**根本没问过这个账户自己有没有规则**。
   * 于是用户账户 id 是 hj-main、而 YAML 键还是模板里的 卫星账户/核心账户 时，
   * 页面照样显示"规则来自 strategy.yaml 持仓.hj-main"，而 hardLineAlerts 里
   * `rules["hj-main"]` 是 undefined，止损/灾难位/止盈**一条都不生效**。
   * 界面声称纪律在守着、实际没有守 —— 这是这套系统里最不能出现的一类假信息。
   */
  accountsWithRules: string[];
  /** 规则是否来自 strategy.yaml。false = 没读到配置，硬线告警只能靠逐票止损价 */
  rulesFromConfig: boolean;
}

function toAccountRules(raw: Record<string, unknown> | undefined): AccountRules | undefined {
  if (!raw) return undefined;
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
  const 止盈 = Array.isArray(raw.止盈)
    ? raw.止盈.filter((x): x is number => typeof x === "number")
    : undefined;
  const out: AccountRules = {};
  const sl = num(raw.止损);
  const dz = num(raw.灾难位);
  if (sl !== undefined) out.止损 = sl;
  if (dz !== undefined) out.灾难位 = dz;
  if (止盈 && 止盈.length) out.止盈 = 止盈;
  return Object.keys(out).length ? out : undefined;
}

export function positionsView(db: Db, cfg: StrategyConfig | null): PositionsView {
  const pos = positions(db);
  const codes = [...new Set(pos.map((p) => p.code))];
  const quotes = latestQuotes(db, codes);
  const names = securities(db, codes);
  const accs = accounts(db);
  const accIds = new Set(accs.map((a) => a.id));

  // 盘中情绪算不出来不能让持仓页挂掉 —— 它只是叠加的上下文，
  // 而持仓的浮盈亏与硬线告警是必须出来的东西
  const mood = moodOrNull(db);

  const rows: PositionView[] = pos.map((p) => {
    const q = quotes.get(p.code) ?? null;
    const pnl = positionPnl(p, q?.price ?? null);
    return {
      position: p,
      name: names.get(p.code)?.name ?? null,
      quote: q,
      pnl,
      stopGapRatio:
        q && p.stopPx !== null && p.stopPx > 0 ? (q.price - p.stopPx) / p.stopPx : null,
      vsMarket: relStrength(q, mood?.now),
    };
  });

  // 规则按 YAML 里实际存在的账户构建，不预设任何账户名。
  // 用户改了账户名或加了账户，这里自动跟上；写死键名会让硬线告警静默失效
  const rawRules = accountRules(cfg);
  const rules: Record<string, ReturnType<typeof toAccountRules>> = {};
  for (const [acct, raw] of Object.entries(rawRules)) rules[acct] = toAccountRules(raw);

  return {
    rows,
    accounts: accs,
    mood,
    alerts: hardLineAlerts(
      rows.map((r) => ({
        position: r.position,
        price: r.quote?.price ?? null,
        stopPx: r.position.stopPx,
      })),
      rules
    ),
    // 总资产未记录在库里（account 表只有 id/name/type），占比类指标只能是 null
    risk: portfolioRisk(
      rows.map((r) => ({ position: r.position, price: r.quote?.price ?? null })),
      null
    ),
    orphanAccountIds: [...new Set(pos.map((p) => p.accountId).filter((id) => !accIds.has(id)))],
    // 有任一账户从 YAML 读到了规则
    rulesFromConfig: Object.values(rules).some(r => r !== null),
    accountsWithRules: Object.entries(rules)
      .filter(([, r]) => r !== undefined && r !== null)
      .map(([acct]) => acct),
    /** YAML 里配了规则、但 account 表里不存在的账户名 —— 大概率是改名后忘了同步 */
    rulesWithoutAccount: Object.keys(rules).filter(a => !accIds.has(a)),
  };
}

export interface WatchView {
  row: WatchpoolRow;
  name: string | null;
  quote: Quote | null;
  dist: TriggerDistance;
  /** 触发价与止损价的关系不对（止损 >= 触发）→ 这单一开就已经在止损下方 */
  inconsistent: boolean;
  /** 今日涨幅减去全市场平均涨幅（百分点）。正 = 跑赢 */
  vsMarket: number | null;
}

/**
 * 观察池视图里"最近移出、可恢复"条目最多列多少条。
 * 池本身只有几十只量级，20 条足够覆盖误操作的回溯窗口；再多就成流水账了。
 */
const ARCHIVED_LIMIT = 20;

export interface WatchpoolView {
  rows: WatchView[];
  /**
   * 移出过、可以放回的条目。按移出时间倒序没法知道（表里没记移出时刻），
   * 就用加入时间倒序 —— 最近才盯的排在前面。
   *
   * 有这一项是因为软删只留了数据、没留回来的路：移错一只要重新手填
   * 触发价、止损、买入逻辑，而那些值本来就在库里。
   */
  archived: WatchpoolRow[];
  mood: IntradayMood | null;
}

/**
 * 盘中情绪。算不出来返回 null 而不是让调用方崩 ——
 * 情绪是叠加的上下文，休市日没有它就是没有，页面照常显示观察池本身。
 */
function moodOrNull(db: Db): IntradayMood | null {
  try {
    const m = intradayMood(db);
    return m.now === null ? null : m;
  } catch {
    return null;
  }
}

export function watchpoolView(db: Db): WatchpoolView {
  const rows = watchpool(db);
  const codes = rows.map((r) => r.code);
  const quotes = latestQuotes(db, codes);
  const names = securities(db, codes);
  const activeCodes = new Set(rows.map((r) => r.code));
  // 已归档的也要显示名称：很多条只记得代码，放回前得知道放回去的是哪只
  const allRows = watchpool(db, true);
  const archivedCodes = allRows.filter((r) => !activeCodes.has(r.code)).map((r) => r.code);
  const archivedNames = securities(db, archivedCodes);
  const mood = moodOrNull(db);
  return {
    mood,
    archived: allRows
      .filter((r) => !activeCodes.has(r.code))
      .slice(0, ARCHIVED_LIMIT)
      .map((r) => ({ ...r, name: r.name ?? archivedNames.get(r.code)?.name ?? null })),
    rows: rows.map((row) => {
      const q = quotes.get(row.code) ?? null;
      return {
        row,
        name: row.name ?? names.get(row.code)?.name ?? null,
        quote: q,
        dist: triggerDistance(q?.price ?? null, row.triggerPx),
        inconsistent:
          row.triggerPx !== null && row.stopPx !== null && row.stopPx >= row.triggerPx,
        vsMarket: relStrength(q, mood?.now),
      };
    }),
  };
}
