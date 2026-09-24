import { z } from "zod";
import { err, ok, parseQuery, withDb } from "@/lib/ui/api";
import { CodeSchema } from "@/lib/ui/validate";
import { chartData } from "@/lib/ui/adapters/chart";
import { readStrategyConfig } from "@/lib/ui/adapters/strategy";
import { shanghaiTs } from "@/lib/ui/time";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const NSchema = z.coerce.number().int().min(30).max(1000);

/** K 线图：前复权 K 线 + MACD + 日/周线交叉 + 结构位 + M 顶 W 底 */
export function GET(req: Request) {
  const code = parseQuery(req.url, "code", CodeSchema);
  if (!code.ok) return code.res;
  const rawN = new URL(req.url).searchParams.get("n");
  const n = rawN === null ? { success: true as const, data: 250 } : NSchema.safeParse(rawN);
  if (!n.success) return err(400, "参数 n 不合法（30–1000 的整数）");
  const cfg = readStrategyConfig();
  if (!cfg.available) return err(503, `策略配置不可用：${cfg.reason}`);
  return withDb((db) => {
    const r = chartData(db, code.value, n.data, shanghaiTs(new Date()), cfg.config);
    return r.available ? ok(r) : err(500, r.reason);
  });
}
