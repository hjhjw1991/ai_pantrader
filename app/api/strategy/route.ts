import { err, ok, parseBody } from "@/lib/ui/api";
import { StrategyParamWriteSchema } from "@/lib/ui/validate";
import {
  STRATEGY_YAML_REL,
  flattenConfig,
  loaderReady,
  readStrategyConfig,
  writeStrategyParam,
} from "@/lib/ui/adapters/strategy";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * 策略参数 = config/strategy.yaml 的投影（D7）。
 *
 * GET 每次重新读文件，不缓存 —— 缓存就是第二份状态，而 D7 说只能有一份。
 */
export function GET() {
  const cfg = readStrategyConfig();
  if (!cfg.available) return err(503, cfg.reason, { needs: cfg.needs });
  return ok({
    filePath: cfg.filePath,
    validated: cfg.validated,
    loaderReady: loaderReady(),
    params: flattenConfig(cfg.config),
    raw: cfg.raw,
    note: `唯一真相源是 ${STRATEGY_YAML_REL}；本接口不落任何副本`,
  });
}

/**
 * 写回参数。**当前一律 501**：保留原文注释的写回属于 lib/strategy/loader.ts，
 * 用 js-yaml 往返会把整份 YAML 的注释冲掉，而那些注释记着阈值的由来。
 * 详见 lib/ui/adapters/strategy.ts 的 TODO(loader)。
 */
export async function PUT(req: Request) {
  const b = await parseBody(req, StrategyParamWriteSchema);
  if (!b.ok) return b.res;
  const r = writeStrategyParam(b.value.path.split("."), b.value.value);
  if (!r.ok) return err(501, r.reason ?? "写回未启用");
  return ok({ ok: true });
}
