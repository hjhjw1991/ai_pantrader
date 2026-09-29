import { err, ok, parseBody, withDb } from "@/lib/ui/api";
import { WatchpoolDeleteSchema, WatchpoolRestoreSchema, WatchpoolUpsertSchema } from "@/lib/ui/validate";
import { watchpool } from "@/lib/ui/queries";
import { deactivateWatch, reactivateWatch, upsertWatch } from "@/lib/ui/mutations";
import { writeDb } from "@/lib/ui/db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export function GET() {
  return withDb((db) => ok({ rows: watchpool(db, true) }));
}

/**
 * 加/改观察池条目。这是**人输入的东西**，不是行情，所以前端可以写。
 *
 * 止损价 >= 触发价时拒绝：这样的条目一开仓就已经在止损线下方，
 * 不是笔误就是想反了，落库只会在盘中制造一条假告警。
 */
export async function POST(req: Request) {
  const b = await parseBody(req, WatchpoolUpsertSchema);
  if (!b.ok) return b.res;
  const w = b.value;
  if (w.triggerPx != null && w.stopPx != null && w.stopPx >= w.triggerPx) {
    return err(400, `止损价 ${w.stopPx} 不能高于或等于触发价 ${w.triggerPx}`);
  }
  const db = writeDb();
  upsertWatch(db, w);
  return ok({ ok: true, code: w.code });
}

/**
 * 移出观察池 = 软删（active=0）。盯过什么是复盘素材，不物理删。
 *
 * `removed` 如实报有没有真的移出一只：重复点、或点了一个早就不在池里的代码，
 * changes 都是 0 —— 不明说的话，点了没反应看起来和"删了但页面没刷新"一模一样。
 */
export async function DELETE(req: Request) {
  const b = await parseBody(req, WatchpoolDeleteSchema);
  if (!b.ok) return b.res;
  const db = writeDb();
  const removed = deactivateWatch(db, b.value.code);
  return ok({ ok: true, code: b.value.code, removed });
}

/** 把移出的条目放回来。触发价/止损/买入逻辑都还是原来那套，不重置 */
export async function PATCH(req: Request) {
  const b = await parseBody(req, WatchpoolRestoreSchema);
  if (!b.ok) return b.res;
  const db = writeDb();
  const restored = reactivateWatch(db, b.value.code);
  if (!restored) return err(409, `${b.value.code} 不在观察池里，或已经在池中了`);
  return ok({ ok: true, code: b.value.code, restored });
}
