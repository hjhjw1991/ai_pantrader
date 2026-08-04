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
}

export interface PositionsView {
  rows: PositionView[];
  accounts: AccountRow[];
  alerts: HardLineAlert[];
  risk: PortfolioRisk;
  /** 有 position 行但 account 表查不到对应账户 —— 会导致止损规则套错，必须点名 */
  orphanAccountIds: string[];
  /** YAML 里配了规则、但 account 表里没有的账户名 */
  rulesWithoutAccount: string[];
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
}

export function watchpoolView(db: Db): WatchView[] {
  const rows = watchpool(db);
  const codes = rows.map((r) => r.code);
  const quotes = latestQuotes(db, codes);
  const names = securities(db, codes);
  return rows.map((row) => {
    const q = quotes.get(row.code) ?? null;
    return {
      row,
      name: row.name ?? names.get(row.code)?.name ?? null,
      quote: q,
      dist: triggerDistance(q?.price ?? null, row.triggerPx),
      inconsistent:
        row.triggerPx !== null && row.stopPx !== null && row.stopPx >= row.triggerPx,
    };
  });
}
