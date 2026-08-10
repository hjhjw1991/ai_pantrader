import { err, ok, parseBody, withDb } from "@/lib/ui/api";
import { SweepRunSchema } from "@/lib/ui/validate";
import { SWEEP_MAX_POINTS, runSweep } from "@/lib/ui/adapters/engines";
import { readStrategyConfig } from "@/lib/ui/adapters/strategy";
import { shanghaiTs } from "@/lib/ui/time";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * 参数扫描 → 热力图（spec §10.4）。
 *
 * 和 /api/backtest 同样的两条纪律：
 *   - A股约束不开放给请求参数，一律用回测层默认值；
 *   - 失败返 503 + 原因，**不返回部分热力图** —— 缺格的图会被当成"那片参数不好"读。
 *
 * 每个网格点是一次完整回测，同步跑完（上限 SWEEP_MAX_POINTS）。GET 把上限告诉前端，
 * 让它在按钮旁就能显示"你这网格几个点、超没超"，而不是点下去等半分钟才被拒。
 */
export function GET() {
  const cfg = readStrategyConfig();
  return ok({
    ready: cfg.available,
    maxPoints: SWEEP_MAX_POINTS,
    ...(cfg.available ? {} : { reason: cfg.reason, needs: cfg.needs }),
  });
}

export async function POST(req: Request) {
  const b = await parseBody(req, SweepRunSchema);
  if (!b.ok) return b.res;
  if (b.value.from > b.value.to) return err(400, "起始日期晚于结束日期");

  const cfg = readStrategyConfig();
  if (!cfg.available) return err(503, cfg.reason, { needs: cfg.needs, issues: cfg.issues });

  return withDb((db) => {
    const r = runSweep(db, {
      from: b.value.from,
      to: b.value.to,
      config: cfg.config,
      initialCash: b.value.initialCash,
      grid: b.value.grid,
      axisX: b.value.axisX,
      axisY: b.value.axisY,
      // generatedAt 外部注入：重放路径内不许出现 Date.now()（spec §17 断言 4）
      generatedAt: shanghaiTs(),
    });
    if (!r.available) return err(503, r.reason, { needs: r.needs });
    return ok({ report: r.report });
  });
}
