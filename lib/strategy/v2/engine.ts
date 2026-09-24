/**
 * v2 规则引擎：把五个槽装配起来，风控固定施加。
 *
 * 与 v1 的关系：v1 原封不动地留着，作为影子盘里的 baseline 对照组。
 * v2 用 baseline 槽组合时必须与 v1 产出同一张卡（见 tests/strategy/v2/parity.test.ts）——
 * 这不是洁癖，是"新策略必须打赢 baseline 才准毕业"这条门槛的前提：
 * 对照组若与历史口径不一致，赢了输了都说明不了任何事。
 *
 * 引擎自己只做四件槽位不该管的事：
 *   1. 求值日回落（completeDate）与数据缺口上卡
 *   2. 候选源的合并去重与排序（顺序即优先级，必须确定，否则结果不可复现）
 *   3. 已持仓去重（走离场器，不重复开仓）
 *   4. **组合风控**——护栏不可插拔，理由见 contracts/slots.ts
 */
import type {
  Action, Candidate, EvaluatedCandidate, EvaluatorSlot, ExitSlot, FactorRegistry, MainlineSlot,
  PoolRow, SignalCard, SlotChoice, SlotConfig, SlotCtx, SlotRegistry, SourceSlot,
  StockAdvice, StrategyEngineInput, TimerSlot,
} from "@/lib/contracts";
import { techContext, holdingLean } from "@/lib/strategy/v2/advice";
import { structureTarget } from "@/lib/strategy/v2/slots/structure-pricing";
import {
  KNOWN_GAP_KINDS, applyPortfolioCaps, makeRunner, makeWarnings, matchesMainline, resolveDate,
} from "@/lib/strategy/engine";
import { BASELINE_CHOICE } from "@/lib/strategy/v2/slots/baseline";

export interface V2Deps {
  registry: FactorRegistry;
  slots: SlotRegistry;
}

export interface V2Input extends StrategyEngineInput {
  /**
   * 槽位选择。不给就用 baseline 组合 —— 现存的 YAML 一份都没有 `槽位:` 段，
   * 它们理应继续按原样工作，而不是因为引擎升级就跑不起来。
   */
  slotConfig?: SlotConfig;
  /**
   * 出持仓与观察池建议（card.advice）。只有界面要：盘前计划、影子盘、回测都不开，
   * 卡片形状与 v1 逐字段一致（parity）。建议那一轮的因子告警不进 card.warnings，理由同上。
   */
  advice?: { watchlist: Array<{ code: string; name?: string | null }> };
}

/** 取一个槽，取不到直接抛：槽位配错了要当场失败，不能悄悄退回默认实现 */
function pick<T>(
  slots: SlotRegistry, kind: "择时器" | "主线识别器" | "评估器" | "离场器", choice: SlotChoice
): { slot: T; params: Record<string, unknown> } {
  const s = slots.get(kind, choice.用);
  if (s === undefined) {
    const 可选 = slots.list(kind).map(x => x.name).join(" / ");
    throw new Error(`槽位未注册：${kind} "${choice.用}"（已注册：${可选 === "" ? "无" : 可选}）`);
  }
  return { slot: s as T, params: choice.参数 ?? {} };
}

export function createV2Engine(deps: V2Deps) {
  return (input: V2Input): SignalCard => {
    const { view, config, phase } = input;
    const w = makeWarnings();
    const warn = (m: string): void => { w.add(m); };
    const date = resolveDate(view);

    // 数据缺口必须上卡（spec §10.5）：缺口日的判断可信度天然打折
    for (const kind of KNOWN_GAP_KINDS) {
      if (view.hasGap(date, kind)) {
        warn(`数据缺口未修复：${kind}@${date} —— 当日判断可信度下降`);
      }
    }
    if (view.hasGap(date)) {
      warn(`${date} 存在未修复的数据缺口，回测须计入覆盖率`);
    }

    const runner = makeRunner(deps.registry, config, view, date, warn);
    const ctx: SlotCtx = {
      view, config, phase, date,
      registry: deps.registry,
      sectorOf: input.sectorOf,
      sectorMapAt: input.sectorMapAt,
      runFactor: (name, extra) => runner.run(name, extra),
      warn,
    };

    /**
     * 槽位来源优先级：显式入参 > YAML 的 `槽位:` 段 > baseline。
     *
     * 入参优先是给影子盘用的：同一份 YAML 要被多套槽组合各跑一遍，
     * 总不能为此改用户的策略文件。
     */
    const sc: SlotConfig =
      input.slotConfig ?? config.槽位 ?? (BASELINE_CHOICE as unknown as SlotConfig);

    /* ② 主线 → ① 择时。主线在前：档位判定要用主线名单 */
    const ml = pick<MainlineSlot>(deps.slots, "主线识别器", sc.主线识别器 ?? BASELINE_CHOICE.主线识别器);
    const mainline = ml.slot.detect(ctx, ml.params);

    const tm = pick<TimerSlot>(deps.slots, "择时器", sc.择时器 ?? BASELINE_CHOICE.择时器);
    const { env, stage } = tm.slot.assess(ctx, tm.params, mainline);

    const heldCodes = new Set(input.positions.map(p => p.code));
    if (input.positions.length > 0) {
      /**
       * 引擎不知道账户有多少钱，这是**设计决定，不是待办**（与 v1 同一条边界）。
       * 一个算不出下单金额的引擎，没法被顺手接到自动交易上。
       */
      warn(
        `组合风控：引擎按设计不接账户资金（只出比例，换算成金额由人做），` +
        `新开仓预算按目标仓位 ${env.targetPosition} 全额计算，未扣除现有 ${input.positions.length} 笔持仓的占比，请人工核对`
      );
    }

    /* ③ 候选源：按配置顺序扫，合并去重 */
    let candidates: Candidate[] = [];
    if (env.gear !== "防守") {
      const seen = new Set<string>();
      const pool: PoolRow[] = [];
      for (const choice of sc.候选源 ?? BASELINE_CHOICE.候选源) {
        const src = pick<SourceSlot>(deps.slots, "候选源" as any, choice);
        for (const row of src.slot.scan(ctx, src.params, mainline.names)) {
          // 多路命中同一只票时先到的胜出：顺序即优先级，与 v1 一致
          if (seen.has(row.code)) continue;
          seen.add(row.code);
          pool.push(row);
        }
      }
      // 排序先定死：连板高 → 封单大 → 代码。抖动就是结果不可复现
      pool.sort((a, b) => b.lbc - a.lbc || b.sealAmt - a.sealAmt || (a.code < b.code ? -1 : 1));

      /* ④ 评估器 */
      const ev = pick<EvaluatorSlot>(deps.slots, "评估器", sc.评估器 ?? BASELINE_CHOICE.评估器);
      const evaluated: EvaluatedCandidate[] = [];
      for (const row of pool) {
        if (heldCodes.has(row.code)) continue;              // 已持仓的走离场器，不重复开仓
        const m = matchesMainline(row.sector, mainline.names);
        if (m === null) continue;                           // 不在主线上的不追
        const c = ev.slot.evaluate(ctx, ev.params, row, m);
        if (c !== null) evaluated.push(c);
      }
      evaluated.sort((a, b) => b.score - a.score || (a.code < b.code ? -1 : 1));

      /* 组合风控：固定，不可插拔 */
      candidates = applyPortfolioCaps(evaluated, config, env.targetPosition);
    }

    /* ⑤ 离场器 */
    const ex = pick<ExitSlot>(deps.slots, "离场器", sc.离场器 ?? BASELINE_CHOICE.离场器);
    const sorted = [...input.positions].sort((a, b) =>
      (a.account < b.account ? -1 : a.account > b.account ? 1 : 0) || (a.code < b.code ? -1 : 1));
    const holdings = sorted.map(p => ex.slot.decide(ctx, ex.params, p, env));

    const advice = input.advice === undefined ? undefined : buildAdvice(deps, input, ctx, date, env.gear, mainline.names, sc, candidates, holdings);

    return {
      // 时间只来自视图。这里读一次系统时钟，回测与实盘就走了两条不同的路径
      ts: view.asOf,
      phase,
      strategyId: config.id,
      strategyName: config.名称 ?? config.id,
      env,
      candidates,
      holdings,
      warnings: w.list,
      advisorInfluenced: false,
      // 只在判出阶段时才带这个键：baseline 择时器不判阶段，带上 undefined 也会改卡片形状
      ...(stage !== undefined ? { stage } : {}),
      ...(advice !== undefined ? { advice } : {}),
    };
  };
}

/**
 * 持仓与观察池建议。用一个**静音**的因子执行器：这一轮的低置信告警、否决理由只归到各自那只票的
 * reasons 里，不进卡片的 warnings —— 否则开不开建议，同一张卡的告警就不一样了。
 */
function buildAdvice(
  deps: V2Deps, input: V2Input, ctx: SlotCtx, date: string, gear: string, mainlines: string[],
  sc: SlotConfig, candidates: Candidate[], holdings: Candidate[],
): StockAdvice[] {
  let sink: string[] = [];
  const quiet = makeRunner(deps.registry, input.config, input.view, date, m => { sink.push(m); });
  const qctx: SlotCtx = { ...ctx, runFactor: (name, extra) => quiet.run(name, extra), warn: m => { sink.push(m); } };
  const tech = (code: string, held: boolean) => techContext({
    daily: quiet.run("日线MACD", { code }), weekly: quiet.run("周线MACD", { code }),
    structure: quiet.run("结构位", { code }), pattern: quiet.run("M顶W底", { code }), atr: quiet.run("ATR", { code }),
  }, held);
  const nameOf = (code: string) => input.view.security(code)?.name ?? null;
  const out: StockAdvice[] = [];

  for (const h of holdings) {
    const t = tech(h.code, true);
    out.push({
      code: h.code, name: h.name ?? nameOf(h.code), kind: "持仓", action: h.action, reasons: [h.thesis].filter(x => x.length > 0),
      triggerPx: h.triggerPx, stopPx: h.stopPx, targetPx: null, rrRatio: null, targetRef: false, mainline: null, tech: t, lean: holdingLean(t),
    });
  }

  const held = new Set(holdings.map(h => h.code));
  const ev = pick<EvaluatorSlot>(deps.slots, "评估器", sc.评估器 ?? BASELINE_CHOICE.评估器);
  for (const w of input.advice!.watchlist) {
    if (held.has(w.code)) continue;
    sink = [];
    const t = tech(w.code, false);
    const base = { code: w.code, name: w.name ?? nameOf(w.code), kind: "观察" as const, tech: t, lean: null };
    const hit = candidates.find(c => c.code === w.code);
    // 正式评估器不带定价时，按结构位定价槽的同一套公式补参考目标价
    const priced = (trig: number | null, stop: number | null, tp: unknown, rr: number | null | undefined) => {
      if (typeof tp === "number") return { targetPx: tp, rrRatio: rr ?? null, targetRef: false };
      const r = trig === null ? null : structureTarget(trig, stop, t.resistance, t.atr);
      return r === null ? { targetPx: null, rrRatio: null, targetRef: false } : { targetPx: r.target, rrRatio: r.rr, targetRef: true };
    };
    if (hit !== undefined) {
      out.push({ ...base, action: "今日候选", reasons: [hit.thesis], triggerPx: hit.triggerPx, stopPx: hit.stopPx,
        ...priced(hit.triggerPx, hit.stopPx, hit.targetPx, hit.rrRatio), mainline: null });
      continue;
    }
    const sector = input.sectorOf?.(w.code) ?? null;
    const m = matchesMainline(sector, mainlines);
    const c = ev.slot.evaluate(qctx, ev.params, { code: w.code, sector, lbc: 0, sealAmt: 0, source: "观察池" }, m ?? sector ?? "未知");
    const reasons: string[] = [];
    if (gear === "防守") reasons.push("今日防守档（0 仓），不开新仓");
    if (m === null) reasons.push(sector === null ? "查不到行业，判断不了在不在主线上" : `不在今日主线（${sector}）`);
    // 按完整代码匹配（前后不能再接数字），免得一条讲别的票的告警恰好含这串数字
    const own = new RegExp(`(^|\\D)${w.code}(\\D|$)`);
    reasons.push(...sink.filter(x => own.test(x) || x.startsWith("过滤器未判定")).map(x => x.replace(`${w.code} `, "")));
    const ok = c !== null && m !== null && gear !== "防守";
    out.push({
      ...base,
      action: ok ? "可买（到触发价）" : c === null ? "不买" : "暂不买",
      reasons: ok ? [c!.thesis] : reasons.length > 0 ? reasons : ["评估器未给出候选（多半是讲不出买入逻辑或缺数据）"],
      triggerPx: c?.triggerPx ?? null, stopPx: c?.stopPx ?? null,
      ...priced(c?.triggerPx ?? null, c?.stopPx ?? null, c?.targetPx, c?.rrRatio), mainline: m,
    });
  }
  return out;
}

/** 兜底：Action 类型在本文件未直接使用，但导出的卡片依赖它，保留引用避免误删 */
export type { Action };
