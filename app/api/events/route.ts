import { readDb } from "@/lib/ui/db";
import { recentNotifications } from "@/lib/ui/notify";
import { latestQuoteTs } from "@/lib/ui/queries";
import { shanghaiTs } from "@/lib/data/clock";

export const dynamic = "force-dynamic";
/** SSE 必须走 Node runtime：edge 上没有 better-sqlite3 */
export const runtime = "nodejs";

/**
 * SSE 事件流（spec §13 的推送）。
 *
 * 为什么是**轮询数据库**而不是内存事件总线：采集跑在独立守护进程里
 * （scripts/daemon.ts），网页服务是另一个进程。内存总线在这里永远收不到采集事件。
 * 轮询 DB 是跨进程且不需要额外基础设施的做法；只在真的有变化时才推，
 * 所以静默期的开销就是一条 SELECT MAX(ts)。
 *
 * 两类事件分开，因为处理方式完全不同：
 *   data   数据新鲜度变了 → 前端软刷新，**不弹桌面通知**
 *   notify 关键信号 → 按 severity 决定是否弹通知
 */
const POLL_MS = 3_000;
const HEARTBEAT_MS = 25_000;

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const sinceId = Number.parseInt(url.searchParams.get("sinceId") ?? "0", 10) || 0;

  const stream = new ReadableStream({
    async start(controller) {
      const enc = new TextEncoder();
      let lastId = sinceId;
      let lastQuoteTs: string | null = null;
      let lastBeat = Date.now();
      let closed = false;

      const send = (event: string, data: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        } catch { closed = true; }
      };

      const tick = () => {
        if (closed) return;
        const db = readDb();
        if (db === null) {
          send("error", { message: "数据库不可用" });
          return;
        }

        const ts = latestQuoteTs(db);
        if (ts !== lastQuoteTs) {
          lastQuoteTs = ts;
          send("data", { latestQuoteTs: ts, at: shanghaiTs() });
        }

        const fresh = recentNotifications(db, lastId).reverse();
        for (const n of fresh) {
          lastId = Math.max(lastId, n.id);
          send("notify", n);
        }

        // 心跳：反向代理与浏览器都会掐掉长时间无字节的连接
        if (Date.now() - lastBeat > HEARTBEAT_MS) {
          lastBeat = Date.now();
          send("ping", { at: shanghaiTs() });
        }
      };

      tick();
      const timer = setInterval(tick, POLL_MS);

      // 客户端断开（关页面/刷新）必须停轮询，否则每次刷新都漏一个定时器
      req.signal.addEventListener("abort", () => {
        closed = true;
        clearInterval(timer);
        try { controller.close(); } catch { /* 已关 */ }
      });
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      // 关掉中间层缓冲，否则事件会被攒着一起发
      "X-Accel-Buffering": "no",
    },
  });
}
