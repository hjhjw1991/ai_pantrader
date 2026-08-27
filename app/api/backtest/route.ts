import { err, ok, parseBody } from "@/lib/ui/api";
import { BacktestRunSchema } from "@/lib/ui/validate";
import { runBacktestAsync, ReplayAborted } from "@/lib/ui/adapters/engines";
import { readStrategyConfig } from "@/lib/ui/adapters/strategy";
import { openRead, writeDb } from "@/lib/ui/db";
import { saveBacktestReport } from "@/lib/ui/mutations";
import { tryAcquire, release } from "@/lib/ui/heavy";
import { shanghaiTs } from "@/lib/ui/time";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export function GET() {
  const cfg = readStrategyConfig();
  return ok({
    ready: cfg.available,
    ...(cfg.available ? {} : { reason: cfg.reason, needs: cfg.needs }),
  });
}

/**
 * 跑回测，流式返回进度。
 *
 * 为什么是流：四年跨度 6 分钟。一个憋 6 分钟才回话的请求，用户无法判断它是在跑
 * 还是已经挂了，也没有任何办法叫停。
 *
 * 失败时**不返回部分结果**：一条不完整的净值曲线会被当成策略成绩读，
 * 而策略成绩决定投多少钱。
 *
 * A股约束不开放给请求参数：T+1 / 涨停买不进 / 跌停卖不出 / 停牌不成交 / 滑点 / 费率
 * 一律用回测层默认值。关掉任何一条都会让回测虚高。
 */
export async function POST(req: Request) {
  const b = await parseBody(req, BacktestRunSchema);
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

  // 与参数扫描共用同一把锁：它们抢的是同一个 CPU，分成两把只会让
  // "回测跑着的时候还能开扫描"这种最坏组合合法化
  const lock = tryAcquire("backtest", `${b.value.from} → ${b.value.to}`);
  if (!lock.ok) return err(409, lock.reason);
  const { job } = lock;
  const abort = job.abort;

  // 客户端断开（点了取消 / 关了页面）就停：跑一个没人要的 6 分钟回测，
  // 既白烧 CPU，又让下一个真要跑的人卡在 409 上
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
        // generatedAt 由这里注入：重放路径内不许出现 Date.now()，否则同份输入两次跑出
        // 的报告哈希不一致（spec §17 断言 4）
        const out = await runBacktestAsync(db, {
          from: b.value.from,
          to: b.value.to,
          config: cfg.config,
          initialCash: b.value.initialCash,
          generatedAt: shanghaiTs(),
        }, {
          signal: abort,
          onProgress: p => line({ phase: "day", done: p.done, total: p.total, date: p.date }),
        });
        if (!out.available) { line({ phase: "error", ok: false, reason: out.reason, needs: out.needs }); }
        else {
          // 先存档再回消息：报告是花了几分钟算出来的，落库失败也要让用户拿到结果，
          // 但反过来"回了消息才存"会在这中间断线时把结果丢掉
          let archivedId: string | null = null;
          try {
            const w = writeDb();
            archivedId = saveBacktestReport(w, {
              kind: "backtest",
              strategyId: out.report.strategyId,
              strategyVersion: out.report.strategyVersion,
              from: b.value.from, to: b.value.to,
              initialCash: b.value.initialCash,
              metrics: out.report.metrics,
              report: out.report,
            });
            w.close();
          } catch (e) {
            // 存档失败不该把跑成功的回测变成失败：结果照给，只是没存住
            line({ phase: "archive_failed", reason: (e as Error).message });
          }
          line({ phase: "done", ok: true, report: out.report, archivedId });
        }
      } catch (e) {
        // 取消不是错误：报成失败会让用户以为是自己的策略配置有问题
        if (e instanceof ReplayAborted) line({ phase: "aborted", ok: false, reason: e.message });
        else line({ phase: "error", ok: false, reason: (e as Error).message });
      } finally {
        release(job);
        try { controller.close(); } catch { /* 已关闭 */ }
      }
    },
    cancel() {
      // 浏览器侧 AbortController 触发的取消也走同一条路
      abort.aborted = true;
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Accel-Buffering": "no",
    },
  });
}
