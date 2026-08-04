import { ok, withDb } from "@/lib/ui/api";
import { unresolvedGaps } from "@/lib/ui/queries";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * 未解决缺口。recoverable=false 的行是永久损失（spec §18.2）：
 * 分钟线与截面数据没有历史接口，缺一天永远缺一天，回测覆盖率要永久扣分。
 */
export function GET() {
  return withDb((db) => {
    const all = unresolvedGaps(db);
    return ok({
      unrecoverable: all.filter((g) => !g.recoverable),
      recoverable: all.filter((g) => g.recoverable),
      note: "unrecoverable 不可事后补救，只能记入覆盖率；recoverable 可由 backfill job 重取",
    });
  });
}
