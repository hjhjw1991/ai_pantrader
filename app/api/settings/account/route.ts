import { ok, parseBody, withDb } from "@/lib/ui/api";
import { AccountUpsertSchema } from "@/lib/ui/validate";
import { accounts } from "@/lib/ui/queries";
import { upsertAccount } from "@/lib/ui/mutations";
import { writeDb } from "@/lib/ui/db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export function GET() {
  return withDb((db) => ok({ rows: accounts(db) }));
}

/**
 * 建/改账户。两个账户的语义不可混用（贼王吃波动、价值扛逻辑），
 * type 只能是这两个之一，由 schema 卡住。
 */
export async function POST(req: Request) {
  const b = await parseBody(req, AccountUpsertSchema);
  if (!b.ok) return b.res;
  const db = writeDb();
  upsertAccount(db, b.value);
  return ok({ ok: true, id: b.value.id });
}
