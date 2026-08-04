import { NextResponse } from "next/server";
import type { ZodType } from "zod";
import { readDb, dbPath } from "@/lib/ui/db";

/**
 * API 路由的共用外壳。
 *
 * 只监听 localhost 不等于可以不校验：浏览器里任何页面都能对 127.0.0.1 发请求，
 * 而这些路由能改观察池、能落成交记录。所以规矩是 ——
 * **校验不过就 400 拒绝，绝不猜参数**；SQL 一律绑定参数。
 */

export function ok<T>(data: T): NextResponse {
  return NextResponse.json(data, {
    // 行情接口的缓存就是过期价，一律禁掉
    headers: { "Cache-Control": "no-store" },
  });
}

export function err(status: number, message: string, extra?: unknown): NextResponse {
  return NextResponse.json(
    { error: message, ...(extra === undefined ? {} : { issues: extra }) },
    { status, headers: { "Cache-Control": "no-store" } }
  );
}

/** 库不存在 → 503，并把期望路径带出去，方便看是不是 PANTRADER_DATA_DIR 指错了 */
export function withDb<T>(fn: (db: NonNullable<ReturnType<typeof readDb>>) => T): T | NextResponse {
  const db = readDb();
  if (!db) return err(503, `数据库不存在或无法读取：${dbPath()}`);
  return fn(db);
}

/** 解析 + 校验查询参数 */
export function parseQuery<T>(
  url: string,
  key: string,
  schema: ZodType<T>
): { ok: true; value: T } | { ok: false; res: NextResponse } {
  const raw = new URL(url).searchParams.get(key);
  if (raw === null) return { ok: false, res: err(400, `缺少查询参数 ${key}`) };
  const r = schema.safeParse(raw);
  if (!r.success) return { ok: false, res: err(400, `参数 ${key} 不合法`, r.error.issues) };
  return { ok: true, value: r.data };
}

export async function parseBody<T>(
  req: Request,
  schema: ZodType<T>
): Promise<{ ok: true; value: T } | { ok: false; res: NextResponse }> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return { ok: false, res: err(400, "请求体不是合法 JSON") };
  }
  const r = schema.safeParse(body);
  if (!r.success) return { ok: false, res: err(400, "请求体校验失败", r.error.issues) };
  return { ok: true, value: r.data };
}
