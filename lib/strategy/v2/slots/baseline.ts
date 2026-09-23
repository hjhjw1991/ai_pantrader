/**
 * baseline 槽位组合：行为等价于 v1 引擎。
 *
 * 这套默认槽的实现全部是**对 v1 已验证函数的薄适配**，不是把逻辑抄一遍。
 * 这是刻意的，理由有三条：
 *
 *   1. 零行为漂移。v1 那 127 个测试就是这套实现的安全网 —— 抄一遍就得再写一套
 *      等价性证明，而"两份看起来一样的代码"随时间必然分岔。
 *   2. 可插拔性来自**槽位接口**，不来自代码是否重复。换掉其中任何一个槽，
 *      换的是接口的另一份实现，与默认实现怎么写无关。
 *   3. v1 退役时，把函数体搬进这里即可，调用方一行不用改。
 *
 * baseline 存在的意义不是"好用"，是**可比**：影子盘里新策略的毕业门槛是
 * "打赢 baseline"，那就必须有一个与历史口径完全一致的对照组。
 */
import type {
  Candidate, EnvAssessment, EvaluatedCandidate, EvaluatorSlot, ExitSlot, MainlineResult,
  MainlineSlot, PoolRow, SlotCtx, SlotParams, SourceSlot, StrategyEngineInput, TimerSlot,
} from "@/lib/contracts";
import {
  accountBoards, accountForBoard, assessGear, candidatePool, collectEnvFacts, decideHolding,
  detectMainlines, evaluateRow, type FactorRunner, type FactsMap,
} from "@/lib/strategy/engine";

/** 版本号统一：baseline 是一个整体，任何一块变了都意味着对照组换了口径 */
const V = "1.0.0";

/**
 * 槽位拿到的是 SlotCtx，而 v1 的函数要 FactorRunner / StrategyEngineInput。
 * 这两个适配器把口径对上，且**只在这里做**——别让 v1 的内部形状漏到别的槽里去。
 */
function runnerOf(ctx: SlotCtx): FactorRunner {
  return {
    run: (name, extra) => ctx.runFactor(name, extra),
    has: name => ctx.registry.get(name) !== undefined,
  };
}

function inputOf(ctx: SlotCtx): StrategyEngineInput {
  return {
    view: ctx.view,
    config: ctx.config,
    phase: ctx.phase,
    // 候选源不看持仓：去重已持仓是引擎的事，不是某一路来源的事
    positions: [],
    sectorOf: ctx.sectorOf,
    sectorMapAt: ctx.sectorMapAt,
  };
}

/* ------------------------------ ② 主线识别器 ------------------------------ */

export const 主线识别器_板块榜叠加必查链: MainlineSlot = {
  kind: "主线识别器", name: "板块榜叠加必查链", version: V,
  detect(ctx: SlotCtx): MainlineResult {
    // facts 由本槽自备：识别过程中求值的 主线识别 / 龙头温度计 要交给择时器并入 env.factors
    const facts: FactsMap = new Map();
    const names = detectMainlines(ctx.config, runnerOf(ctx), ctx.warn, facts);
    return { names, factors: [...facts.values()] };
  },
};

/* ------------------------------- ① 择时器 ------------------------------- */

export const 择时器_三档阈值: TimerSlot = {
  kind: "择时器", name: "三档阈值", version: V,
  assess(ctx: SlotCtx, _params: SlotParams, mainline: MainlineResult): { env: EnvAssessment } {
    const facts = collectEnvFacts(runnerOf(ctx));
    // 并入主线识别产出的因子。不并的话 env.factors 会少两条，而卡片上看不出来少了
    for (const f of mainline.factors) facts.set(f.name, f);
    const env = assessGear(
      ctx.config, runnerOf(ctx), ctx.warn,
      // 对照日用 asOf 的日期部分：ctx.date 已经回落过，用它自己比自己永远相等，
      // "横截面因子评估的是昨天"这条告警就永远出不来
      ctx.view.asOf.slice(0, 10), facts, mainline.names
    );
    /**
     * stage 暂不给。
     *
     * 五段状态机要用的因子（首板晋级率、连板晋级率、高度板次日溢价、炸板股次日溢价、
     * 涨跌幅中位数…）目前一个都还没有，现在硬判一个阶段等于往影子盘的分组键里灌噪声，
     * 而分组键一旦被污染，按阶段统计出来的胜率全部不可信。
     * 因子层补齐后另出一个「五段状态机」择时器，与本实现并行跑影子盘比高下。
     */
    return { env };
  },
};

/* ------------------------------ ③ 候选源 ×3 ------------------------------ */

/**
 * 三路候选源。
 *
 * 实现手法是"只开自己那一路，复用 v1 的 candidatePool" —— 看着绕，但它保证了
 * 每一路的行为与 v1 逐字一致（包括量价那一路在缺 代码→行业 映射时自动关闭并告警、
 * 以及映射采集时刻晚于评估日时的前视告警）。自己重写三个循环省不了多少代码，
 * 却要把那两条告警逻辑也跟着抄一遍，抄漏一条就是静默的行为差异。
 */
function onlySource(ctx: SlotCtx, which: "涨停池" | "主线领涨" | "量价"): StrategyEngineInput {
  const input = inputOf(ctx);
  return {
    ...input,
    config: {
      ...ctx.config,
      选股: {
        ...ctx.config.选股,
        候选来源: { 涨停池: which === "涨停池", 主线领涨: which === "主线领涨", 量价: which === "量价" },
      },
    },
  };
}

function makeSource(which: "涨停池" | "主线领涨" | "量价"): SourceSlot {
  return {
    kind: "候选源", name: which, version: V,
    scan(ctx: SlotCtx, _params: SlotParams, mainlines: string[]): PoolRow[] {
      return candidatePool(onlySource(ctx, which), mainlines, ctx.date, ctx.warn);
    },
  };
}

export const 候选源_涨停池 = makeSource("涨停池");
export const 候选源_主线领涨 = makeSource("主线领涨");
export const 候选源_量价 = makeSource("量价");

/* ------------------------------- ④ 评估器 ------------------------------- */

export const 评估器_七道筛打分: EvaluatorSlot = {
  kind: "评估器", name: "七道筛打分", version: V,
  evaluate(
    ctx: SlotCtx, _params: SlotParams, row: PoolRow, mainline: string
  ): EvaluatedCandidate | null {
    const c = evaluateRow(
      inputOf(ctx), runnerOf(ctx), row, mainline,
      accountBoards(ctx.config), ctx.config.选股.过滤器阈值, ctx.warn
    );
    if (c === null) return null;
    /**
     * targetPx / rrRatio 给 null，不给 0。
     *
     * v1 压根没有"目标位"这个概念（只有固定止盈档 0.08/0.15），所以这里没得可填。
     * 填 0 会让盈亏比算出 0 或负数，而下游若拿它排序，等于宣称"这些票赔率极差"——
     * 缺数据被伪装成了一个很坏的真实读数，这是最危险的一类假阳性。
     * 结构位定价进来之后由新的评估器槽提供，baseline 保持"没有就是没有"。
     */
    return {
      code: c.code, name: c.name, account: c.account,
      sector: c.sector, mainline: c.mainline,
      triggerPx: c.triggerPx, stopPx: c.stopPx,
      targetPx: null, rrRatio: null,
      thesis: c.thesis, passedFilters: c.passedFilters,
      factors: c.factors, score: c.score,
    };
  },
};

/* ------------------------------- ⑤ 离场器 ------------------------------- */

export const 离场器_账户纪律: ExitSlot = {
  kind: "离场器", name: "账户纪律", version: V,
  decide(ctx: SlotCtx, _params: SlotParams, position, env: EnvAssessment): Candidate {
    return decideHolding(inputOf(ctx), position, env.gear, ctx.warn, runnerOf(ctx));
  },
};

/* --------------------------------- 汇总 --------------------------------- */

export const BASELINE_SLOTS = [
  择时器_三档阈值,
  主线识别器_板块榜叠加必查链,
  候选源_涨停池,
  候选源_主线领涨,
  候选源_量价,
  评估器_七道筛打分,
  离场器_账户纪律,
];

/**
 * 不写 `槽位:` 段时用的组合。
 *
 * 候选源的顺序即优先级（多路命中同一只票时先到的胜出），必须与 v1 的
 * candidatePool 内部顺序一致：涨停池 → 主线领涨 → 量价。
 */
export const BASELINE_CHOICE = {
  择时器: { 用: "三档阈值" },
  主线识别器: { 用: "板块榜叠加必查链" },
  候选源: [{ 用: "涨停池" }, { 用: "主线领涨" }, { 用: "量价" }],
  评估器: { 用: "七道筛打分" },
  离场器: { 用: "账户纪律" },
} as const;
