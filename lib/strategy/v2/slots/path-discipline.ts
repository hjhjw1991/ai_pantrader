/**
 * ⑤ 离场器 · 路径纪律
 *
 * 它跟 baseline 的「账户纪律」认的不是同一批线：
 *   账户纪律   -10% 止损（收盘确认）/ -15% 灾难位 / +6% 清仓 —— **全是价格线，没有时间概念**
 *   路径纪律   移动止损、破均线、时间止损、持有上限 —— **全是账户纪律认不出来的线**
 *
 * 分工是刻意的：**止损与止盈仍然由账户纪律负责，本槽不去重复实现。**
 * 两处各算一遍同一条线，迟早出现"卡片上写着 −10%、槽里按 −8% 判"这种最难查的不一致；
 * 而且 止损确认=收盘 这类细节抄漏一条，就会在盘中把不该砍的砍掉。
 * 所以本槽走叠加：先问账户纪律拿一个判定，只可能把它**加重**，不可能减轻。
 *
 * ⚠️ 所有参数默认关闭，装上这个槽**不改变任何行为**。
 *   这不是偷懒。2026-10-07 在 4637 笔配对样本上把这几类规则扫了一遍，结论是：
 *   在实盘口径（-10% 止损 + +6% 目标）之上，移动止损 / 保本 / 破均线 / 时间止损 / 持有上限
 *   **全是负增量**（Δ −0.11 ~ −0.26 个百分点/笔）。默认打开等于把没通过的规则直接上线。
 *   参数留在这里是因为"能测"要有地方落脚，不是因为"该开"。
 *
 * 判断逻辑在 lib/shadow/exit-policy.ts —— 与评测脚本共用同一份实现。
 * 评测出来什么样的规则，实盘跑的就是什么样的规则；两边分岔的话，
 * 调参只是在给一个没人执行的东西调参数。
 */
import type {
  Candidate, EnvAssessment, ExitSlot, SlotCtx, SlotParams, StrategyEngineInput,
} from "@/lib/contracts";
import { decideHolding, type FactorRunner } from "@/lib/strategy/engine";
import { decideToday, dropRulesNeedingAge, scalePath, type ExitPolicy, type PathBar } from "@/lib/shadow/exit-policy";

const V = "1.0.0";

/** 槽参数里写 0（或缺省）表示"不启用" */
const OFF = 0;

/** 与 baseline 槽里同名的两个适配器保持一致，避免 v1 的内部形状漏到各自的槽里 */
function runnerOf(ctx: SlotCtx): FactorRunner {
  return {
    run: (name, extra) => ctx.runFactor(name, extra),
    has: name => ctx.registry.get(name) !== undefined,
  };
}

function inputOf(ctx: SlotCtx): StrategyEngineInput {
  return {
    view: ctx.view, config: ctx.config, phase: ctx.phase,
    positions: [], sectorOf: ctx.sectorOf, sectorMapAt: ctx.sectorMapAt,
  };
}

function num(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return null;
}

/**
 * YAML 里写 0（或缺省）表示"不启用"，这里统一翻译成模拟器认识的形状：
 *   持有上限 0 → 无限期（一个足够大的数，而不是让它保持 0 —— 0 会被理解成"当天就到期"）
 *   破均线 0   → null
 * 哨兵值不讲究好看，讲究的是"关"这个意图不会因为某个 0 走进不等式而变成"立刻生效"。
 */
export function policyFromSlotParams(params: SlotParams): ExitPolicy {
  const 起 = num(params["移动止损起"]), 回撤 = num(params["移动止损回撤"]);
  const 日 = num(params["时间止损第几日"]), 低于 = num(params["时间止损低于"]);
  const h = num(params["持有上限"]) ?? OFF;
  const ma = num(params["破均线"]) ?? OFF;
  return {
    到期: h > 0 ? h : Number.MAX_SAFE_INTEGER,
    目标: null,   // 止盈归账户纪律，这里不重复实现
    硬止损: null,
    不用计划止损: true,
    移动止损: 起 !== null && 回撤 !== null ? { 起, 回撤 } : null,
    破均线: ma > 0 ? ma : null,
    时间止损: 日 !== null && 日 > 0 ? { 第几日: 日, 低于: 低于 ?? 0 } : null,
  };
}

export const 离场器_路径纪律: ExitSlot = {
  kind: "离场器", name: "路径纪律", version: V,
  decide(ctx: SlotCtx, params: SlotParams, position, env: EnvAssessment): Candidate {
    // 基准判定：账户权限、停牌、防守档、灾难位、ST、风险叠加全在里面（v1 的测试盖着）
    const base = decideHolding(inputOf(ctx), position, env.gear, ctx.warn, runnerOf(ctx));
    const tag = (t: string): Candidate => ({ ...base, thesis: `${base.thesis}；路径纪律：${t}` });

    const pol = policyFromSlotParams(params);
    const asked = Object.keys(params).length > 0;

    const cost = position.cost;
    if (!(cost > 0)) return tag("成本为 0，无法按持有路径判定");

    const missingAge = position.openDate === null || position.openDate === undefined;
    const eff = missingAge ? dropRulesNeedingAge(pol).pol : pol;
    if (missingAge) {
      const dropped = dropRulesNeedingAge(pol).dropped;
      if (dropped.length > 0) {
        ctx.warn(`路径纪律：${position.code} 缺建仓日，"${dropped.join("、")}"未生效`);
      }
    }
    const hasRule = asked && (eff.到期 !== Number.MAX_SAFE_INTEGER || eff.破均线 !== null
      || eff.移动止损 !== null || eff.时间止损 !== null);
    if (!hasRule) return tag("未启用任何线条，动作完全由账户纪律决定");

    const bars = ctx.view.dailyBars(position.code, 250);
    if (bars.length === 0) return tag("无日线，无法判定");

    const from = position.openDate ?? "";
    const i = bars.findIndex(b => b.date >= from);
    const pathRaw = i < 0 ? [] : bars.slice(i);
    if (pathRaw.length === 0) return tag(`建仓日 ${from} 之后还没有K线`);
    const path: PathBar[] = scalePath(pathRaw, 0);

    const d = decideToday(eff, {
      path, entryPx: cost,
      // 止损/目标归账户纪律，这里传 null —— 本槽只跑自己那几条线
      planStopPx: null, planTargetPx: null,
      slippage: 0, feeRate: 0,
      ...(ctx.phase === "盘中" ? { 盘中: true } : {}),
    });

    if (!d.走) return tag(`已持有 ${d.held} 个交易日，未触发任何线条`);
    return {
      ...base,
      action: "清仓", size: 0, triggerPx: null, stopPx: null,
      thesis: `${base.thesis}；路径纪律清仓：${d.reason}（第 ${d.held} 个交易日` +
        `${d.onDate === null ? "" : ` · ${d.onDate}`}${d.px === null ? "" : ` @${d.px.toFixed(2)}`}）`,
    };
  },
};

export const PATH_DISCIPLINE_SLOTS = [离场器_路径纪律];
