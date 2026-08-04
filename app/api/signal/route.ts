import { err, ok, withDb } from "@/lib/ui/api";
import { todaySignalCard } from "@/lib/ui/adapters/engines";
import { readStrategyConfig } from "@/lib/ui/adapters/strategy";
import { systemStatus } from "@/lib/ui/status";
import { shanghaiTs } from "@/lib/ui/time";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * 当日信号卡。
 *
 * 产不出来时返回 **503 + 明确原因**，不返回一个空的 SignalCard 骨架 ——
 * 空骨架会被调用方渲染成"今日无信号"，那是个错误的结论：
 * 真相是"系统这次没能给出信号"。这两件事不能混。
 */
export function GET() {
  const cfg = readStrategyConfig();
  if (!cfg.available) return err(503, cfg.reason, { needs: cfg.needs, issues: cfg.issues });

  return withDb((db) => {
    const asOf = shanghaiTs();
    const r = todaySignalCard(db, asOf, cfg.config);
    if (!r.available) return err(503, r.reason, { needs: r.needs });
    return ok({
      card: r.card,
      phase: r.phase,
      asOf: r.asOf,
      universe: r.universe,
      executionMode: systemStatus().executionMode,
      note: "信号卡不等于下单指令：manual 模式下需在券商 App 手敲，回来在持仓页回填成交",
    });
  });
}
