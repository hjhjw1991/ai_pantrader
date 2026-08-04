import { err, ok, parseBody, withDb } from "@/lib/ui/api";
import { BacktestRunSchema } from "@/lib/ui/validate";
import { runBacktest } from "@/lib/ui/adapters/engines";
import { readStrategyConfig } from "@/lib/ui/adapters/strategy";
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
 * 跑回测。
 *
 * 失败时返回 503 + 原因，**不返回部分结果**：一条不完整的净值曲线会被当成
 * 策略成绩读，而策略成绩决定投多少钱。
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

  return withDb((db) => {
    // generatedAt 由这里注入：重放路径内不许出现 Date.now()，否则同份输入两次跑出
    // 的报告哈希不一致（spec §17 断言 4）
    const r = runBacktest(db, {
      from: b.value.from,
      to: b.value.to,
      config: cfg.config,
      initialCash: b.value.initialCash,
      generatedAt: shanghaiTs(),
    });
    if (!r.available) return err(503, r.reason, { needs: r.needs });
    return ok({ report: r.report });
  });
}
