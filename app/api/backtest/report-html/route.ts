import { NextResponse } from "next/server";
import { err, parseQuery, withDb } from "@/lib/ui/api";
import { backtestReportById } from "@/lib/ui/queries";
import { checkBacktestShape, renderTearsheet } from "@/lib/backtest/tearsheet";
import { DEFAULT_BENCHMARK, loadBenchmarkWithStats } from "@/lib/backtest/benchmark";
import { z } from "zod";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** 存档 id 是"数字时刻 + 36 进制随机后缀"，只放行这个形状 */
const IdSchema = z.string().regex(/^\d{8,20}-[0-9a-z]{1,8}$/, "存档 id 格式不合法");
/** 基准代码。可选，缺省沪深300；给 none 表示不比 */
const BenchSchema = z.string().min(1).max(16).optional();

/**
 * 取回测报告的 tearsheet（自包含 HTML）。
 *
 * 为什么要一个专门的下载接口而不是让前端自己拼：报告 JSON 只在服务端，
 * 而渲染它的那条规则 —— 零外部请求、所有插值转义 —— 属于归档，
 * 不该在浏览器里重实现一遍。浏览器重写的版本迟早和 CLI 导出的那份长得不一样，
 * 而"同一份存档导出两种报告"是无法向人解释的事情。
 *
 * 给出 attachment：目标是拿去存档/发人，不是在当前标签页里替换掉应用。
 */
export function GET(req: Request) {
  const b = parseQuery(req.url, "id", IdSchema);
  if (!b.ok) return b.res;

  const benchRaw = new URL(req.url).searchParams.get("bench") ?? undefined;
  const bp = BenchSchema.safeParse(benchRaw);
  if (!bp.success) return err(400, "bench 参数不合法");

  return withDb((db) => {
    const hit = backtestReportById(db, b.value);
    if (hit === null) return err(404, "存档不存在，或那份报告已损坏无法解析");
    if (hit.kind === "sweep") {
      return err(400, "这是参数扫描报告，结构不同，导不出 tearsheet。请选一份回测。");
    }
    const c = checkBacktestShape(hit.report);
    if (!c.ok) {
      return err(400, `这份存档不是有效的回测报告，缺：${c.missing.join("、")}`);
    }

    /**
     * 基准在服务端取好再喂进渲染器 —— 与 CLI 同一条路径、同一份判据。
     * 写 "none" 才关掉；不给就走默认（沪深300）。
     * 取不到时不报错，报告里会写明原因：下载一份没有基准的报告，
     * 好过因为指数那天没数据而整个下载失败。
     */
    let benchOpts: Parameters<typeof renderTearsheet>[1] = {};
    if (bp.data !== "none") {
      const r = loadBenchmarkWithStats(db, bp.data ?? DEFAULT_BENCHMARK, c.report.equity);
      benchOpts = r.ok
        ? { benchmark: { series: r.series, stats: r.stats } }
        : { benchmarkReason: r.reason };
    }

    const html = renderTearsheet(c.report, { note: `　由存档 ${b.value} 导出。`, ...benchOpts });
    return new NextResponse(html, {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Disposition": `attachment; filename="backtest-${b.value}.html"`,
        "Cache-Control": "no-store",
      },
    });
  });
}
