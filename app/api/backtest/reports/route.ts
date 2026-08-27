import { err, ok, parseQuery, withDb } from "@/lib/ui/api";
import { backtestReports, backtestReportById } from "@/lib/ui/queries";
import { deleteBacktestReport } from "@/lib/ui/mutations";
import { writeDb } from "@/lib/ui/db";
import { z } from "zod";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** 存档 id 是"数字时刻 + 36 进制随机后缀"，只放行这个形状 */
const IdSchema = z.string().regex(/^\d{8,20}-[0-9a-z]{1,8}$/, "存档 id 格式不合法");

/**
 * 回测/扫描存档。
 *
 * 不带 id → 列表（只含摘要，不读整份 JSON）；
 * 带 id   → 取那一份完整报告。
 *
 * 分两种读法而不是一次全给：列表页一个字段都用不到 report_json，
 * 而几十份完整报告是几 MB 的无谓开销。
 */
export function GET(req: Request) {
  const raw = new URL(req.url).searchParams.get("id");
  if (raw === null) return withDb((db) => ok({ rows: backtestReports(db) }));

  const id = IdSchema.safeParse(raw);
  if (!id.success) return err(400, "存档 id 格式不合法", id.error.issues);
  return withDb((db) => {
    const r = backtestReportById(db, id.data);
    // 分开报：id 不存在（可能被保留数挤掉了）和 JSON 坏了，处置完全不同
    if (r === null) return err(404, "存档不存在，或那份报告已损坏无法解析");
    return ok(r);
  });
}

export async function DELETE(req: Request) {
  const b = await parseQuery(req.url, "id", IdSchema);
  if (!b.ok) return b.res;
  const db = writeDb();
  try {
    deleteBacktestReport(db, b.value);
    return ok({ ok: true, id: b.value });
  } finally {
    db.close();
  }
}
