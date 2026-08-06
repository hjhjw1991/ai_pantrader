import { err, ok, parseBody, withDb } from "@/lib/ui/api";
import { AccountUpsertSchema, AccountActiveSchema } from "@/lib/ui/validate";
import { accounts } from "@/lib/ui/queries";
import { upsertAccount, deleteAccount, setAccountActive, accountExists } from "@/lib/ui/mutations";
import { writeDb } from "@/lib/ui/db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export function GET() {
  return withDb((db) => ok({ rows: accounts(db) }));
}

/**
 * 建/改账户。名称与类型标签都由用户定义，代码不预设任何账户 ——
 * 账户是用户组织自己资金的方式，程序无权替他起名。
 *
 * 每账户的止损/仓位规则来自 strategy.yaml 里以账户 id 为键的那一段，
 * 不由这里的 type 标签决定：标签只用于分组展示。
 */
export async function POST(req: Request) {
  const b = await parseBody(req, AccountUpsertSchema);
  if (!b.ok) return b.res;
  const db = writeDb();
  upsertAccount(db, b.value);
  return ok({ ok: true, id: b.value.id });
}

/** 停用 / 恢复。停用的账户不再出现在新建表单里，但历史台账仍按它分组 */
export async function PATCH(req: Request) {
  const b = await parseBody(req, AccountActiveSchema);
  if (!b.ok) return b.res;
  const db = writeDb();
  if (!accountExists(db, b.value.id)) return err(404, `账户不存在：${b.value.id}`);
  setAccountActive(db, b.value.id, b.value.active);
  return ok({ ok: true, id: b.value.id, active: b.value.active });
}

/**
 * 删账户。**有台账引用时只停用**，返回 mode 告诉界面实际发生了什么 ——
 * 点了"删除"结果只是停用了，这件事必须说出来，不能让界面自己猜。
 */
export async function DELETE(req: Request) {
  const id = new URL(req.url).searchParams.get("id");
  if (!id) return err(400, "缺少 id 参数");
  const db = writeDb();
  if (!accountExists(db, id)) return err(404, `账户不存在：${id}`);
  const r = deleteAccount(db, id);
  return ok(r);
}
