import { err, ok, parseBody } from "@/lib/ui/api";
import { ShadowSwitchActionSchema } from "@/lib/ui/validate";
import { writeDb } from "@/lib/ui/db";
import { variantReports } from "@/lib/shadow/report";
import { switchStatus, approveSwitch, rejectSwitch, rollbackSwitch } from "@/lib/shadow/switch";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * 影子盘看板：各变体成绩单（实盘 / 回放分开）、毕业进度、待批提案、切换历史。
 * 读的是 writeDb：switchStatus 要读策略文件并核对在任组合，和切换操作走同一个连接。
 */
export function GET() {
  try {
    const db = writeDb();
    return ok({
      live: variantReports(db, "live"),
      replay: variantReports(db, "replay"),
      ...switchStatus(db),
    });
  } catch (e) {
    return err(500, (e as Error).message);
  }
}

/** 批准 / 否决 / 回滚。改的是策略文件，明天盘前计划起生效 */
export async function POST(req: Request) {
  const b = await parseBody(req, ShadowSwitchActionSchema);
  if (!b.ok) return b.res;
  try {
    const db = writeDb();
    const v = b.value;
    const r = v.action === "approve" ? approveSwitch(db, v.id, "human")
      : v.action === "reject" ? rejectSwitch(db, v.id, v.note ?? null)
      : rollbackSwitch(db, v.note === undefined ? {} : { note: v.note });
    return ok({ ok: true, switch: r });
  } catch (e) {
    return err(400, (e as Error).message);
  }
}
