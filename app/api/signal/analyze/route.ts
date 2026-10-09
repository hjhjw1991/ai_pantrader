import { err, ok, parseQuery, withDb } from "@/lib/ui/api";
import { CodeSchema } from "@/lib/ui/validate";
import { stockAnalysis } from "@/lib/ui/adapters/analyze";
import { readStrategyConfig } from "@/lib/ui/adapters/strategy";
import { shanghaiTs } from "@/lib/ui/time";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * 单票按需分析：趋势读数 + 买卖点。
 *
 * 与作战台的区别是**只算这一只**：作战台一渲染就把候选、持仓、观察池全跑一遍，
 * 池子大了要几秒；这里是点谁算谁。趋势与买卖点分开返回 —— 策略 YAML 写错时
 * 只有买卖点那一段为空，趋势读数照常给，不因为配置问题让人连 K 线都看不了。
 */
export function GET(req: Request) {
  const code = parseQuery(req.url, "code", CodeSchema);
  if (!code.ok) return code.res;
  const cfg = readStrategyConfig();
  if (!cfg.available) return err(503, `策略配置不可用：${cfg.reason}`);
  return withDb((db) => {
    const r = stockAnalysis(db, code.value, shanghaiTs(new Date()), cfg.config);
    return r.available ? ok(r) : err(500, r.reason);
  });
}
