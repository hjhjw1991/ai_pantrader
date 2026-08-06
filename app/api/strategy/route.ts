import { err, ok, parseBody } from "@/lib/ui/api";
import {
  StrategyParamWriteSchema, StrategyCreateSchema, StrategyActivateSchema,
} from "@/lib/ui/validate";
import {
  strategyYamlRel,
  flattenConfig,
  loaderReady,
  readStrategyConfig,
  writeStrategyParam,
} from "@/lib/ui/adapters/strategy";
import {
  listStrategies, activeStrategyId, createStrategy, setActiveStrategy,
  STRATEGIES_DIR_REL,
} from "@/lib/strategy/registry";
import { deleteStrategy } from "@/lib/ledger/strategy-snapshot";
import { writeDb } from "@/lib/ui/db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * 策略参数 = 当前生效那份 YAML 的投影（D7）。
 *
 * GET 每次重新读文件，不缓存 —— 缓存就是第二份状态，而 D7 说只能有一份。
 * 同时返回全部策略清单：界面要能看见"我有哪几个策略、现在跑的是哪个"。
 */
export function GET() {
  const list = listStrategies();
  const active = activeStrategyId();
  const cfg = readStrategyConfig();
  const base = {
    strategies: list, activeId: active, dirRel: STRATEGIES_DIR_REL,
    /** 多个策略却没有 ACTIVE 指针 = 未决状态，界面必须让用户选一个 */
    undecided: active === null && list.length > 1,
  };

  if (!cfg.available) {
    // 不返 503：清单本身是好的，而策略读不出来时用户最需要的正是
    // "我到底有哪几个文件、现在指着哪个"。用 503 会让界面连清单都拿不到
    return ok({ ...base, available: false, error: cfg.reason, needs: cfg.needs });
  }
  return ok({
    ...base,
    available: true,
    filePath: cfg.filePath,
    validated: cfg.validated,
    loaderReady: loaderReady(),
    params: flattenConfig(cfg.config),
    raw: cfg.raw,
    note: `唯一真相源是 ${strategyYamlRel()}；本接口不落任何副本`,
  });
}

/** 新建策略：复制现有策略的原文（含注释），只改 id 行 */
export async function POST(req: Request) {
  const b = await parseBody(req, StrategyCreateSchema);
  if (!b.ok) return b.res;
  try {
    const r = createStrategy(b.value.id, b.value.from);
    return ok({ ok: true, ...r });
  } catch (e) {
    return err(400, (e as Error).message);
  }
}

/**
 * 切换生效策略。
 *
 * 切之前 registry 会整份校验：切到一个校验不过的策略等于让系统立刻停止出信号，
 * 而用户以为自己只是换了个参数集。
 */
export async function PATCH(req: Request) {
  const b = await parseBody(req, StrategyActivateSchema);
  if (!b.ok) return b.res;
  try {
    setActiveStrategy(b.value.id);
    return ok({ ok: true, activeId: b.value.id });
  } catch (e) {
    return err(400, (e as Error).message);
  }
}

/**
 * 删除策略。有预测挂在它上面时先把原文快照进 strategy 表再删文件 ——
 * 否则 prediction.strategy_id 会指向一个不存在的策略，历史结论再也归不了因。
 */
export async function DELETE(req: Request) {
  const id = new URL(req.url).searchParams.get("id");
  if (!id) return err(400, "缺少 id 参数");
  try {
    const r = deleteStrategy(writeDb(), id);
    return ok(r);
  } catch (e) {
    return err(400, (e as Error).message);
  }
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
