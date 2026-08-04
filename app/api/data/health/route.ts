import { ok } from "@/lib/ui/api";
import { systemStatus } from "@/lib/ui/status";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** 源健康 + 快照新鲜度。桌面通知/外部监控可以轮询这个 */
export function GET() {
  const s = systemStatus();
  return ok({
    dbPath: s.dbPath,
    dbExists: s.dbExists,
    dbUnreadable: s.dbUnreadable,
    quoteTs: s.quoteTs,
    quoteAgeMinutes: s.quoteAgeMinutes,
    quoteStale: s.quoteStale,
    inSession: s.inSession,
    worstHealth: s.worstHealth,
    sources: s.health,
    executionMode: s.executionMode,
    liveBlockedReason: s.liveBlockedReason,
  });
}
