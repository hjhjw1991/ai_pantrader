import { ok, withDb } from "@/lib/ui/api";
import { appliedMigrations } from "@/lib/ui/db";
import { advisorOutputs, calendarRange, getMetaValue, tableCountsCached } from "@/lib/ui/queries";
import { scheduleStatus, storageInfo } from "@/lib/ui/settings-info";
import { systemStatus } from "@/lib/ui/status";
import { loaderReady, readStrategyConfig } from "@/lib/ui/adapters/strategy";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export function GET() {
  return withDb((db) => {
    const cfg = readStrategyConfig();
    const advisor = advisorOutputs(db, 1);
    const counted = tableCountsCached(db);
    return ok({
      storage: storageInfo(),
      schedule: scheduleStatus(),
      migrations: appliedMigrations(db),
      systemStartDate: getMetaValue(db, "system_start_date"),
      calendar: calendarRange(db),
      // countsAt 一起给出去：调用方要能看出这批数字是什么时候数的
      counts: counted.counts,
      countsAt: counted.at,
      status: systemStatus(),
      strategy: {
        available: cfg.available,
        loaderReady: loaderReady(),
        ...(cfg.available ? { filePath: cfg.filePath, validated: cfg.validated } : { reason: cfg.reason }),
      },
      // advisor_output 为空 = 从未调用过模型，不等于 null 模式
      advisor: advisor[0] ?? null,
    });
  });
}
