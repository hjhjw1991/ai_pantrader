import { z } from "zod";
import { ok, parseQuery, withDb } from "@/lib/ui/api";
import { searchSecurities } from "@/lib/ui/queries";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * 标的搜索（加观察池时用）。
 * 关键词只做长度/字符限制，之后作为 LIKE 的**绑定参数**传入，不拼进 SQL。
 */
const QSchema = z.string().trim().min(1).max(20);

export function GET(req: Request) {
  const q = parseQuery(req.url, "q", QSchema);
  if (!q.ok) return q.res;
  return withDb((db) => ok({ results: searchSecurities(db, q.value, 20) }));
}
