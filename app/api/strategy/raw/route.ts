import { err, ok, parseBody, parseQuery } from "@/lib/ui/api";
import { StrategyIdSchema, StrategyRawWriteSchema } from "@/lib/ui/validate";
import { readStrategyRawById, writeStrategyRaw } from "@/lib/ui/adapters/strategy";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * 策略原文的读写。
 *
 * 为什么要有这条独立于 /api/strategy 的路由：那条返回的是**当前生效**策略的
 * 投影（参数表 + 原文），够参数面板用；原文编辑器要能编辑任意一个策略，
 * 包括**校验不过**的那个 —— 恰恰是校验不过的时候人最需要打开它改。
 * 所以这里读原文不做校验，写的时候才校验。
 *
 * 写的完整保护链在 lib/ui/adapters/strategy.ts 的 writeStrategyRaw：
 * id 一致性 → 乐观并发（baseHash）→ 整份校验 → 写前备份 → 临时文件 + rename。
 */

export function GET(req: Request) {
  const q = parseQuery(req.url, "id", StrategyIdSchema);
  if (!q.ok) return q.res;
  const r = readStrategyRawById(q.value);
  if ("error" in r) return err(404, r.error);
  return ok(r);
}

export async function PUT(req: Request) {
  const b = await parseBody(req, StrategyRawWriteSchema);
  if (!b.ok) return b.res;
  const { id, text, baseHash, dryRun } = b.value;
  const r = writeStrategyRaw(id, text, baseHash, { dryRun: dryRun === true });
  if (!r.ok) {
    // 409 而不是 400：并发冲突是"状态变了"，客户端的正确反应是重新载入而不是改参数
    const status = r.conflict === true ? 409 : 400;
    return err(status, r.reason ?? "写回失败", r.issues);
  }
  return ok(r);
}
