import { writeDb } from "@/lib/ui/db";
import { markRead, parseReadUpToId } from "@/lib/ui/notify";

export const dynamic = "force-dynamic";
/** better-sqlite3 跑不了 edge */
export const runtime = "nodejs";

/**
 * 标记通知已读（铃铛里的"全部已读"）。
 *
 * 只标 read_at 仍为空的行（`markRead` 内部 `WHERE read_at IS NULL`），所以重复调用
 * 是幂等的 —— 第二次返回 0，不会把"已读时间"又刷成现在。
 *
 * 入参 upToId：把 id <= upToId 的全部未读标成已读。选"id 游标"而不是"全部"，
 * 是因为盘中通知在持续写入，一句"全标"会把同一瞬间新进来的、用户根本还没看到的
 * 也一起抹掉。前端传的是当前手上最大的 id。
 *
 * 注意：这是写操作，必须用写连接（writeDb），不能用只读的 withDb ——
 * 后者拿的是 readonly 连接，UPDATE 会报 "attempt to write a readonly database"。
 *
 * 这里不引 @/lib/ui/api 的 ok/err：那一层会带进 next/server，而 next/server 在测试
 * 环境里触发 vitest 的 SSR 转译缓存写入系统临时目录，受限环境下会 EPERM 把整文件测试拖垮。
 * 本路由直接返回标准 Response 即可。
 */
function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

export async function POST(req: Request) {
  let body: any;
  try {
    body = await req.json();
  } catch {
    return json({ error: "请求体不是合法 JSON" }, 400);
  }
  // typeof 守卫先于 Number()：Number(null) === 0、Number(undefined) === NaN，
  // 单独用 Number() 会把 null 误放进非负整数分支当成"标 0 条"。必须显式拒绝非 number。
  const upToId = parseReadUpToId(body?.upToId);
  if (upToId === null) {
    return json({ error: `upToId 不合法：${JSON.stringify(body?.upToId)}（需要非负整数）` }, 400);
  }

  const db = writeDb();
  try {
    const marked = markRead(db, upToId);
    return json({ marked });
  } finally {
    db.close();
  }
}
