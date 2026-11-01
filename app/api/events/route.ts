import { readDb } from "@/lib/ui/db";
import { recentNotifications, connectionBackfill } from "@/lib/ui/notify";
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
/** 连接时回填到铃铛的历史条数，与 /api/notifications 的默认页一致 */
const HISTORY_LIMIT = 50;

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
      /**
       * 连接时刻的水位：此刻之前的通知都算"历史"，单独走 history 事件回填到铃铛，
       * 客户端不会把它当新消息弹桌面通知。notify 事件只承载水位之后新产生的通知。
       *
       * 修复前：每次刷新都把最近 50 条历史一并走 notify 推下来，客户端每条都
       * `new Notification(...)`，于是"已经看过、确认过的"通知被一遍遍重弹。
       */
      let waterMark = sinceId;
      let backfilled = false;

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

        // 首次连接只回填历史（铃铛与顶栏硬线展示用），不弹桌面通知。
        // backfilled 守卫保证历史只在连接时推一次；之后水位之后的新通知才走 notify。
        if (!backfilled) {
          const { history, waterMark: wm } = connectionBackfill(db, sinceId, HISTORY_LIMIT);
          waterMark = wm;
          lastId = wm;
          backfilled = true;
          send("history", history);
        }

        // 只推连接时刻水位之后新产生的通知
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
