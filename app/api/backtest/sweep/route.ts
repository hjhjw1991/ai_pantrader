import { err, ok, parseBody } from "@/lib/ui/api";
import { SweepRunSchema } from "@/lib/ui/validate";
import { SWEEP_MAX_POINTS, runSweepAsync, ReplayAborted } from "@/lib/ui/adapters/engines";
import { readStrategyConfig } from "@/lib/ui/adapters/strategy";
import { openRead } from "@/lib/ui/db";
import { tryAcquire, release } from "@/lib/ui/heavy";
import { shanghaiTs } from "@/lib/ui/time";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * 参数扫描 → 热力图（spec §10.4）。
 *
 * 和 /api/backtest 同样的两条纪律：
 *   - A股约束不开放给请求参数，一律用回测层默认值；
 *   - 失败返错 + 原因，**不返回部分热力图** —— 缺格的图会被当成"那片参数不好"读。
 *
 * GET 把上限告诉前端，让它在按钮旁就能显示"你这网格几个点、超没超"，
 * 而不是点下去等半分钟才被拒。
 */
export function GET() {
  const cfg = readStrategyConfig();
  return ok({
    ready: cfg.available,
    maxPoints: SWEEP_MAX_POINTS,
    ...(cfg.available ? {} : { reason: cfg.reason, needs: cfg.needs }),
  });
}

/**
 * 跑扫描，流式返回进度。
 *
 * 这里比单次回测严重一个数量级：每个网格点是一次**完整回测**，
 * 36 点 × 四年跨度 ≈ 3.7 小时（实测 0.38 秒/交易日）。
 * 憋几个小时才回话的请求，用户既判断不了它是在跑还是挂了，也没有办法叫停。
 */
export async function POST(req: Request) {
  const b = await parseBody(req, SweepRunSchema);
  if (!b.ok) return b.res;
  if (b.value.from > b.value.to) return err(400, "起始日期晚于结束日期");

  const cfg = readStrategyConfig();
  if (!cfg.available) return err(503, cfg.reason, { needs: cfg.needs, issues: cfg.issues });

  const r = openRead();
  if (!r.ok) {
    return r.why.kind === "missing"
      ? err(503, `数据库不存在：${r.why.path}`)
      : err(503, `数据库打不开（文件存在）：${r.why.path} —— ${r.why.detail}`);
  }
  const db = r.db;

  // 与单次回测共用同一把锁：抢的是同一个 CPU
  const lock = tryAcquire("sweep", `${b.value.from} → ${b.value.to}`);
  if (!lock.ok) return err(409, lock.reason);
  const { job } = lock;
  const abort = job.abort;

  /**
   * 客户端断开（点了取消 / 关了页面）就停：跑一个没人要的长任务，
   * 既白烧 CPU，又让下一个真要跑的人卡在 409 上。
   *
   * 承重的是下面那个流的 cancel()，不是这里的 req.signal。浏览器 abort 掉 fetch 之后
   * 响应体的流会被 cancel，那条路实测可靠（3 秒取消，服务端当场停在第 1 个网格点、锁随即释放）。
   *
   * req.signal 只是加一道保险，**不能只靠它**：Node 里派生 AbortSignal 的监听是弱引用，
   * parseBody 之后本函数不再用到 req，运行时若也没别处持有，signal 会被 GC 掉，
   * abort 事件从此不再送达。实测过这种情形 —— 取消点了没反应，任务一路跑到底。
   * 试过把 signal 绑进流闭包里强引用，没有救回来，所以不要在这上面加设计假设。
   */
  req.signal.addEventListener("abort", () => { abort.aborted = true; });

  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const line = (o: unknown) => {
        try { controller.enqueue(enc.encode(JSON.stringify(o) + "\n")); }
        catch { abort.aborted = true; }   // 写不进去说明对面走了，没必要接着跑
      };
      try {
        // 兜住"注册监听之前请求就已经断了"的竞态
        if (req.signal.aborted) abort.aborted = true;
        line({ phase: "start", from: b.value.from, to: b.value.to });
        const out = await runSweepAsync(db, {
          from: b.value.from,
          to: b.value.to,
          config: cfg.config,
          initialCash: b.value.initialCash,
          grid: b.value.grid,
          axisX: b.value.axisX,
          axisY: b.value.axisY,
          // generatedAt 外部注入：重放路径内不许出现 Date.now()（spec §17 断言 4）
          generatedAt: shanghaiTs(),
        }, {
          signal: abort,
          onProgress: p => line({
            phase: "point", point: p.point, points: p.points,
            day: p.day, days: p.days, date: p.date, params: p.params,
          }),
        });
        if (!out.available) line({ phase: "error", ok: false, reason: out.reason, needs: out.needs });
        else line({ phase: "done", ok: true, report: out.report });
      } catch (e) {
        // 取消不是错误：报成失败会让用户以为是自己的网格配错了
        if (e instanceof ReplayAborted) line({ phase: "aborted", ok: false, reason: e.message });
        else line({ phase: "error", ok: false, reason: (e as Error).message });
      } finally {
        release(job);
        try { controller.close(); } catch { /* 已关闭 */ }
      }
    },
    cancel() { abort.aborted = true; },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Accel-Buffering": "no",
    },
  });
}
