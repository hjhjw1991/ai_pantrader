import { ok, withDb } from "@/lib/ui/api";
import { dashboard, paramSuggestions, winRateStats } from "@/lib/ui/adapters/ledger";
import { shanghaiParts } from "@/lib/ui/status";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * 胜率与仪表盘切片。口径全部来自 lib/ledger，这里不再算一遍。
 *
 * stats 为 null 表示**还没有已结算样本**，不是 0% 命中率。
 * 调用方必须区分这两者：把"无样本"显示成 0% 会让人以为策略已经失效。
 */
export function GET() {
  return withDb((db) => {
    const asOf = shanghaiParts(new Date()).date;
    return ok({
      asOf,
      stats: winRateStats(db),
      dashboard: dashboard(db, asOf),
      suggestions: paramSuggestions(db),
      note: "stats=null 表示无已结算样本；参数建议只出建议，不改 YAML",
    });
  });
}
