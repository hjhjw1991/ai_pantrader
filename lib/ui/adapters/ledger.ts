import type Database from "better-sqlite3";
import type { ParamSuggestion } from "@/lib/contracts/ledger";
import {
  ledgerDashboard,
  suggestParamChanges,
  winRate,
  type LedgerDashboard,
  type LedgerWinRateStats,
} from "@/lib/ledger";

/**
 * 台账适配器。统计口径全部委派给 lib/ledger —— 前端不自己算胜率。
 *
 * 理由不是省事：winrate / dashboard / suggest 三处的 WHERE 口径必须完全一致，
 * 否则同一批数据能出三个不同的胜率，那个数字就没法用来做决策了。
 * 前端再算一遍就是第四个口径。
 *
 * 前端只保留一条自己的规矩：**0 条已结算样本时返回 null，不返回 rate=0**。
 * 0% 命中率会被读成"策略已失效"，而真相是"还没有一条预测到期对过账"，
 * 两者的处置动作完全相反。
 */

type Db = Database.Database;

export function winRateStats(db: Db): LedgerWinRateStats | null {
  const s = winRate(db);
  return s.total === 0 ? null : s;
}

/**
 * 仪表盘切片。**不返回 null**：即使没有已结算样本，pending 与 timeline 也有内容
 * （有预测但没到期）。让页面对每一块分别判空，比整块 null 更准确 ——
 * "有 12 条预测在等结算"和"一条预测都没有"是两种不同的状态。
 */
export function dashboard(db: Db, asOf: string): LedgerDashboard {
  return ledgerDashboard(db, { asOf, granularity: "day", timelineLimit: 200 });
}

/** 参数调整建议。只出建议，不自动改 YAML（spec §11 第 4 步） */
export function paramSuggestions(db: Db): ParamSuggestion[] {
  return suggestParamChanges(db);
}
