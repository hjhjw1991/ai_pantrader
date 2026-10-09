/**
 * 影子盘离场器：让每个变体**自己的离场器槽**参与结算（用户 2026-10-09 选定"影子盘要跑离场器"）。
 *
 * 之前的结算只认计划里的止损价 / 目标价 + 第 5 天期满，离场器槽一行都没跑过 ——
 * 于是只换了离场器的变体（r-exit-hard、hm-* 的游资纪律）结算出来与 baseline 逐笔相同，
 * 拿它们做的退役判定也就无从谈起。
 *
 * ── 口径：叠加，不替换 ────────────────────────────────────────────────
 * 结算的骨架（成交撮合、T+1、止损 / 目标 / 跳空、一字跌停顺延、期满、复权、成本）**不动**，
 * 离场器只是在每天收盘后多问一句"要不要走"，说走就下一个能卖的交易日开盘走（见 settle.ts 文件头）。
 *
 * 但 baseline 的离场器「账户纪律」本身有一套与结算**不同**的线：−10% 收盘确认止损、−15% 灾难位、
 * 止盈档（+6% 清 / 减半）、防守档清仓、ST 清仓、解禁 / 减持 / 超买降成观察。79a29a1 量过两套口径：
 * 同一批入场，影子结算 −0.028%/笔、实盘卡片 +0.480%/笔 —— 若让账户纪律原样跑进结算，
 * **baseline 的历史数字整体改变**，所有挑战者的对照基准跟着换。这一步要用户拍板，这里不擅自做。
 *
 * 于是：调用离场器时，账户纪律那部分被**中和**（NEUTRAL_CONFIG 不给任何账户规则、
 * 视图不给任何因子、档位给中性、持仓止损价给 null），槽只剩**它自己在账户纪律之上叠加的线**：
 *   游资纪律  硬止损（收盘浮亏）、止盈、破 MA5 / MA10、炸板未封
 *   路径纪律  移动止损、破均线、时间止损、持有上限
 *   账户纪律  什么都不剩 —— 等价于旧结算，所以直接不问（legacyEquivalent），数字逐笔不变
 * 所有变体因此仍在**同一套共同口径**（计划止损 / 目标 / 期满）上比，差别只来自各自的离场器增量。
 *
 * ── 时点（无前视）──────────────────────────────────────────────────
 * 第 i 天收盘后问一次，视图只看得到第 i 天及以前的日线（memoryView 截断），判出来的单
 * 第 i+1 个能卖的交易日开盘执行。盘中类的价格线（计划止损 / 目标）仍按 settle 的日内口径成交。
 * 不用 quote：历史某天的快照可能是更早一天留下的，离场器在收盘后判，现价就是当天收盘。
 *
 * ── 价格尺度 ──────────────────────────────────────────────────────
 * 槽看的是 view.dailyBars 的**原始价**；成交价在成交日的原始价尺度。持有期内若除权，
 * 第 i 天传给槽的成本 = 成交价 × f(成交日) / f(第 i 天)，浮盈 = 收盘 / 成本 与结算的复权口径一致。
 *
 * ── 为什么是内存视图 ──────────────────────────────────────────────
 * 每笔预测每天都要建一次视图，几千笔 × 5 天走 sqlite 视图太贵（每个视图实例自带一套语句与缓存）。
 * 现有的离场器只读这只票的日线与证券元数据，内存视图就够；碰到别的方法（换个槽想读龙虎榜之类）
 * 抛 ShadowViewUnsupported，结算侧对这一笔退回 sqlite 视图（同样截断到当天收盘、同样不给 quote）。
 */
import type {
  Candidate, DailyBar, EnvAssessment, ExitSlot, FactorRegistry, PointInTimeView, SecurityRow,
  SlotChoice, SlotConfig, SlotCtx, SlotParams, SlotRegistry, StrategyConfig,
} from "@/lib/contracts";
import { BASELINE_CHOICE, defaultSlotRegistry } from "@/lib/strategy/v2";
import { createRegistry } from "@/lib/factors/registry";
import { repairAdjFactorSeries } from "@/lib/factors/util";
import type { ExitHook, ExitOrder } from "@/lib/shadow/settle";

/** baseline 离场器的槽名（账户纪律）。它在中和之后什么都不剩，见文件头 */
export const BASELINE_EXIT_SLOT: string = BASELINE_CHOICE.离场器.用;

export interface ResolvedExit {
  slot: ExitSlot;
  params: SlotParams;
  /** 落表用的口径标识：`离场器:<槽名>@<版本>`，写进 shadow_outcome.exit_slot */
  key: string;
  /** 中和之后不会出手 → 直接走旧结算，不问（逐笔等价由 tests/shadow/exit-slot.test.ts 对拍） */
  legacyEquivalent: boolean;
}

/** 变体实际用的离场器（没写的按 baseline 补齐）。槽名没注册 → 抛错：结算不能悄悄换成别的离场口径 */
export function resolveExitSlot(slots: SlotConfig | null | undefined, reg: SlotRegistry = defaultSlotRegistry): ResolvedExit {
  const choice: SlotChoice = slots?.离场器 ?? BASELINE_CHOICE.离场器;
  const slot = reg.get("离场器", choice.用) as ExitSlot | undefined;
  if (slot === undefined) throw new Error(`离场器未注册：${choice.用}`);
  return {
    slot, params: choice.参数 ?? {},
    key: `离场器:${slot.name}@${slot.version}`,
    legacyEquivalent: slot.name === BASELINE_EXIT_SLOT,
  };
}

/**
 * 结算行的有效口径。exit_slot 为 NULL 的是 029 之前落的旧结算 —— 只看计划止损 / 目标 / 期满，
 * 与"账户纪律（中和后）"逐笔等价，所以当成它。
 */
export function legacyExitKey(reg: SlotRegistry = defaultSlotRegistry): string {
  return resolveExitSlot(null, reg).key;
}

/**
 * 这条结算记录还算不算数：已结算的行要与变体**当前**的离场器口径一致。
 * 未触发 / 作废与离场口径无关，一律算数。
 */
export function outcomeMatchesExit(status: string | null, exitSlot: string | null, currentKey: string, legacyKey: string): boolean {
  if (status !== "已结算") return true;
  return (exitSlot ?? legacyKey) === currentKey;
}

/**
 * 中和过的策略配置：不给任何账户规则（持仓段为空）。
 * decideHolding 读到的止损 / 灾难位 / 止盈全是空，于是账户纪律只会给"持有 / 观察"。
 * 其它段离场器不读（契约上槽只该读自己那段），给个最小形状，免得误读到某份真实 YAML 的数字。
 */
export const NEUTRAL_CONFIG = {
  id: "shadow-exit-neutral", version: "0.0.0",
  择时: { 仓位档位: { 进攻: 1, 中性: 0.5, 防守: 0 }, 防守触发: {} },
  选股: { 过滤器阈值: {}, 主线识别: { 板块涨幅榜TopN: 0, 必查链: [] } },
  持仓: {},
  组合风控: { 总仓位上限: 1, 单票最大占比: 1, 单行业最大占比: 1, 核心卫星比例: { 核心: 0, 卫星: 1 } },
} as unknown as StrategyConfig;

/** 中性档：防守档会让账户纪律无条件清仓，那是择时器的事，不是离场器的 */
export const NEUTRAL_ENV: EnvAssessment = {
  gear: "中性", targetPosition: 0.5, reasons: ["影子盘离场器：档位中和"], factors: [], lowConfidenceFactors: [],
};

/** 空因子注册表：ST / 解禁 / 减持 / 超买这些风险叠加属于账户纪律，结算口径里本来就没有 */
const EMPTY_FACTORS: FactorRegistry = createRegistry();

export class ShadowViewUnsupported extends Error {
  constructor(what: string) {
    super(`影子盘离场器的内存视图不提供 ${what}`);
    this.name = "ShadowViewUnsupported";
  }
}

/**
 * 只装一只票日线的内存视图，截断到 raw 里 date ≤ asOfDate 的部分。
 * dailyBars 与 sqlite 视图同口径：取最后 n 根，再做窗口内的复权因子自愈（repairAdjFactorSeries）。
 */
export function memoryView(code: string, raw: readonly DailyBar[], asOfDate: string, security: SecurityRow | null): PointInTimeView {
  let end = raw.length;
  while (end > 0 && raw[end - 1].date > asOfDate) end--;
  const seen = raw.slice(0, end);
  const own = (c: string, what: string) => { if (c !== code) throw new ShadowViewUnsupported(`${what}(${c})`); };
  const impl = {
    asOf: `${asOfDate} 15:05:00`,
    dailyBars(c: string, n: number): DailyBar[] {
      own(c, "dailyBars");
      if (n <= 0) return [];
      return repairAdjFactorSeries(seen.slice(Math.max(0, seen.length - n)).map(b => ({ ...b })));
    },
    adjBars(c: string, n: number): DailyBar[] {
      return impl.dailyBars(c, n).map(b => ({ ...b, o: b.o * b.adjFactor, h: b.h * b.adjFactor, l: b.l * b.adjFactor, c: b.c * b.adjFactor }));
    },
    security(c: string): SecurityRow | null { own(c, "security"); return security; },
    quote(): null { return null; },
  };
  return new Proxy(impl as unknown as PointInTimeView, {
    get(t, prop, recv) {
      if (prop in t) return Reflect.get(t, prop, recv);
      if (typeof prop === "symbol" || prop === "then") return undefined;
      return () => { throw new ShadowViewUnsupported(String(prop)); };
    },
  });
}

/** thesis 的最后一段就是槽自己叠加的那句（"游资纪律清仓：…"/"路径纪律清仓：…"），前面是被中和的账户纪律 */
function whyOf(c: Candidate): string {
  const parts = c.thesis.split("；");
  return parts[parts.length - 1] ?? c.thesis;
}

/** 槽的动作 → 结算单。清仓 = 0；减仓按 size（对这笔持仓的保留比例，见 decideHolding），读不出来按减半 */
export function orderOf(c: Candidate): ExitOrder | null {
  if (c.action === "清仓") return { keep: 0, why: whyOf(c) };
  if (c.action === "减仓") {
    const keep = typeof c.size === "number" && c.size > 0 && c.size < 1 ? c.size : 0.5;
    return { keep, why: whyOf(c) };
  }
  return null;
}

export interface SlotHookOpts {
  exit: ResolvedExit;
  code: string;
  account: string;
  /**
   * 原始日线（不复权、不修因子），升序，**含成交日之前的一段**（均线类规则要窗口）以及持有期。
   * 视图按日期截断，不按下标 —— 两边哪怕差一根（停牌、空值行），也不会错位成看到明天。
   */
  raw: readonly DailyBar[];
  /** settleShadow 收到的那组 K 线（成交日起，已修因子）。用它的日期与因子换算成本 */
  bars: readonly DailyBar[];
  security: SecurityRow | null;
  /** 内存视图不够用时的退路（第 i 天收盘时点的 sqlite 视图）。不给就让 ShadowViewUnsupported 抛出去 */
  fallbackView?: (date: string) => PointInTimeView;
}

/**
 * 用变体的离场器槽造一个结算钩子（settleShadow 的第四个参数）。
 * 槽自己抛的错原样抛出 —— 一个有 bug 的离场器不该被当成"没出手"静默跑完。
 */
export function slotExitHook(o: SlotHookOpts): ExitHook {
  let useFallback = false;
  const f0 = o.bars[0]?.adjFactor > 0 ? o.bars[0].adjFactor : 1;
  const openDate = o.bars[0]?.date ?? null;
  return (i: number, entryPx: number): ExitOrder | null => {
    const day = o.bars[i];
    const fi = day.adjFactor > 0 ? day.adjFactor : 1;
    const position = {
      account: o.account, code: o.code,
      // 成交价换到第 i 天的原始价尺度（见文件头"价格尺度"）
      cost: (entryPx * f0) / fi,
      qty: 100,
      // 给 null：给了计划止损，账户纪律会按它在收盘判清仓 —— 那是被中和的部分
      stopPx: null,
      openDate,
    };
    const run = (view: PointInTimeView): Candidate => {
      const ctx: SlotCtx = {
        view, config: NEUTRAL_CONFIG, phase: "盘后", date: day.date, registry: EMPTY_FACTORS,
        runFactor: () => null, warn: () => {},
      };
      return o.exit.slot.decide(ctx, o.exit.params, position, NEUTRAL_ENV);
    };
    if (!useFallback) {
      try {
        return orderOf(run(memoryView(o.code, o.raw, day.date, o.security)));
      } catch (e) {
        if (!(e instanceof ShadowViewUnsupported) || o.fallbackView === undefined) throw e;
        useFallback = true;
      }
    }
    return orderOf(run(o.fallbackView!(day.date)));
  };
}
