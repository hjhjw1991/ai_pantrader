import { err, ok, withDb } from "@/lib/ui/api";
import { todaySignalCard } from "@/lib/ui/adapters/engines";
import { readStrategyConfig } from "@/lib/ui/adapters/strategy";
import { systemStatus } from "@/lib/ui/status";
import { shanghaiTs } from "@/lib/ui/time";
import { diffAndNotify } from "@/lib/ui/notify";
import { positionsView } from "@/lib/ui/views";

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

    // 与上次状态比对，把需要人做动作的变化写成通知（SSE 与桌面通知从 notification 表读）。
    // 放在这里是因为信号卡本来就在这条路径上算好了 —— 另起一个 job 重算等于算两遍。
    // 只读的调用方（比如导出）不会走到这里，所以不会产生噪音通知。
    try {
      const alerts = positionsView(db, cfg.config).alerts.length;
      diffAndNotify(db, r.card, alerts);
    } catch {
      // 通知是增强，算不出来绝不能影响信号卡本身返回
    }

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
