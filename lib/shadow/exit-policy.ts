/**
 * 离场策略：一套参数化的持有路径规则，以及执行它的模拟器。
 *
 * 为什么它是独立模块、而不是塞进 settle.ts：
 *   settleShadow 是**影子盘结算**用的固定口径（止损价 / 目标价 / 5 日期满），
 *   它的职责是把"已经决定好的交易安排"算出一个结果。本模块要做的是反过来 ——
 *   同一个入场，换一套离场规则会怎样。两者混在一起，改动就再也说不清影响了谁。
 *
 * 为什么评测与实盘必须共用同一份实现：
 *   离场规则的收益差别常常只有零点几个百分点，而"评测版"与"上线版"只要有一处
 *   判定顺序、一根 K 线的差别，挑出来的参数就可能落在两边偶然重合的地方。
 *   所以这里只暴露一个按日推进的函数 `stepExit`，评测是把它循环调用，
 *   实盘是每天调用一次 —— **被调用的是同一段代码**。
 *
 * 纪律（与 settle.ts 保持一致的口径）：
 *   T+1：成交当天不能卖，最早第 2 个交易日
 *   跳空：开盘就越线，挂单在开盘成交
 *   同日同时碰到止损与目标 → 算止损（日线看不出先后，取保守）
 *   一字跌停：卖不出去。若当天本该离场，记下原因，顺延到下一个不是一字跌停的交易日**按开盘价**出
 *            （settleShadow 同一口径：不是"顺延后重新判一遍"，而是"昨天就该走、今天开盘走"）
 */
/** 一根已经换算到成交日价格尺度的日线 */
export interface PathBar { date: string; o: number; h: number; l: number; c: number; adjFactor: number }

export interface ExitPolicy {
  /**
   * 持有上限（交易日，成交日算第 1 天）。到这一天的收盘无条件走。
   * 与 settleShadow 的 horizon 同义：5 = 成交当天 + 之后 4 天。
   */
  到期: number;
  /** 目标收益率（百分点，相对成交价）。盘中触及即走。null = 不设目标 */
  目标: number | null;
  /**
   * 硬止损（百分点，相对成交价，负数）。null = 用开仓时计划价换算过来的止损。
   * 两条都不给就完全没有止损。
   */
  硬止损: number | null;
  /**
   * 忽略开仓时算好的计划止损。
   *
   * "没有止损"是一种**真实存在**的配置（YAML 里 `核心账户` 的止损写的是「逻辑破坏」，
   * 引擎因此不给它填 stopPx，只提示人工复核），不是评测用的边角 —— 要测它就得能表达它。
   * 置 true 且 硬止损 为 null = 完全不止损。
   */
  不用计划止损?: boolean;
  /** 移动止损：浮盈先达到 `起`%，之后把止损抬到「峰值 ×(1−回撤%)」 */
  移动止损: { 起: number; 回撤: number } | null;
  /** 收盘跌破 N 日线即走。需要成交日之前的 K 线才算得出来，不足则跳过该条 */
  破均线: number | null;
  /** 时间止损：到第 `第几日` 个交易日收盘，收益还低于 `低于`%，就走 */
  时间止损: { 第几日: number; 低于: number } | null;
}

export const 现行: ExitPolicy = {
  到期: 5, 目标: null, 硬止损: null, 移动止损: null, 破均线: null, 时间止损: null,
};

/** 一笔持仓在推进过程中的状态。逐日推进，只依赖过去 */
export interface ExitState {
  entry: number;
  peak: number;
  stopLvl: number | null;
  targetPx: number | null;
  /**
   * 含当日在内的持有交易日数：成交日 = 1，第二个交易日 = 2。
   *
   * **调用方必须在调 stepExit 前设好当日的值** —— 判断"是否到持有上限""是否到第几日"
   * 都要用含当日的天数，而这个模块不知道今天是第几天。写成 1 = 成交日，
   * 是为了与 settleShadow 的 `i === horizon-1`（第 5 根日线期满）逐笔对得上：
   * 早些版本在这里少算一天，期满日整体后移一根，自检 4637 笔里错了 3918 笔。
   */
  held: number;
  /**
   * 一字跌停当天"本该离场"的原因，下一个能卖的交易日按开盘价出。
   *
   * 与 settleShadow 的 `deferred` 同义。早些版本一字跌停只返回"不走"、第二天重新判一遍，
   * 于是两种情形与结算分岔：期满日一字跌停（结算次日开盘走、模拟次日收盘走），
   * 以及一字跌停已破止损、次日高开回到止损上方（结算开盘止损、模拟拿到期满）。
   * 由 stepExit 在一字跌停日写入，只写一次。
   */
  deferred: ExitReason | null;
}

/** 建初始状态。planStopPx / planTargetPx 必须已换算到成交日的价格尺度 */
export function newExitState(p: ExitPolicy, entryPx: number, planStopPx: number | null, planTargetPx: number | null): ExitState {
  const stopAbs = p.硬止损 !== null
    ? entryPx * (1 + p.硬止损 / 100)
    : p.不用计划止损 === true ? null : planStopPx;
  return {
    entry: entryPx,
    // 峰值从**成交日的盘中高点**起算：入场当天冲高过的部分也算出过浮盈
    peak: entryPx,
    stopLvl: stopAbs,
    targetPx: p.目标 === null ? planTargetPx : entryPx * (1 + p.目标 / 100),
    held: 1,
    deferred: null,
  };
}

export type ExitReason = "止损" | "目标" | "破均线" | "时间止损" | "期满";

export type ExitDecision =
  | { 走: false }
  | { 走: true; px: number; reason: ExitReason };

/**
 * 推进一天。
 *
 * 一字跌停日会改写 `st.deferred`（只写一次）——这是 stepExit 唯一会碰状态的地方，
 * 因为"本该今天走"只有今天判得出来，而成交要等到下一个能卖的交易日。
 *
 * @param prevC 昨日收盘（同一尺度）；用于判一字跌停
 * @param barsSoFar 截至**昨日**的日线（升序，同一尺度），**不含今日** ——
 *   调用方（decideToday / simulateExit）都是判定完今天之后才把今天 push 进去。
 *   破均线因此取的是"今日收盘 vs 截至昨日的 N 日均线"。
 */
export function stepExit(p: ExitPolicy, st: ExitState, today: PathBar, prevC: number, barsSoFar: readonly PathBar[]): ExitDecision {
  const { stopLvl, targetPx } = st;

  // 一字跌停：挂了卖单也成交不了。今天本该走的话记下原因，下一个能卖的日子开盘出
  if (Math.abs(today.h - today.l) < 1e-9 && today.c < prevC) {
    if (st.deferred === null) st.deferred = wouldExitOnLockedDay(p, st, today, barsSoFar);
    return { 走: false };
  }
  if (st.deferred !== null) return { 走: true, px: today.o, reason: st.deferred };

  /**
   * 跳空：开盘就在线的另一侧，实际成交在**开盘价**，不是那条线。
   *
   * 往下跳空卖在开盘 —— 比止损价更差；往上跳空也卖在开盘 —— 比目标价更好。
   * 按"线"成交是最省事的写法，但它是**系统性偏乐观**的：把跳空低开的亏损记少了，
   * 而"要不要更早离场"这类命题恰恰容易被这点乐观喂出假答案。
   * （第一版就写成返回 stopLvl，自检 4637 笔里错 1125 笔，全在这一种情况上。）
   */
  if (stopLvl !== null && today.o <= stopLvl) return { 走: true, px: today.o, reason: "止损" };
  if (targetPx !== null && today.o >= targetPx) return { 走: true, px: today.o, reason: "目标" };

  const stopHit = stopLvl !== null && today.l <= stopLvl;
  const tgtHit = targetPx !== null && today.h >= targetPx;
  if (stopHit) return { 走: true, px: stopLvl, reason: "止损" };
  if (tgtHit) return { 走: true, px: targetPx, reason: "目标" };

  const pnl = st.entry > 0 ? (today.c / st.entry - 1) * 100 : 0;

  if (p.破均线 !== null) {
    const n = p.破均线;
    if (barsSoFar.length >= n) {
      const ma = barsSoFar.slice(barsSoFar.length - n).reduce((a, b) => a + b.c, 0) / n;
      if (today.c < ma) return { 走: true, px: today.c, reason: "破均线" };
    }
  }
  if (p.时间止损 !== null && st.held >= p.时间止损.第几日 && pnl <= p.时间止损.低于) {
    return { 走: true, px: today.c, reason: "时间止损" };
  }
  if (st.held >= p.到期) return { 走: true, px: today.c, reason: "期满" };
  return { 走: false };
}

/**
 * 一字跌停日"本该"以什么理由离场。与 settleShadow 同序：先看止损，再看收盘类规则。
 * 目标价不看 —— 跌停日碰不到目标（settleShadow 也不看）。
 * 破均线 / 时间止损是 settleShadow 没有的规则，按与 stepExit 相同的条件顺延，
 * 默认政策下它们为 null，不影响与结算的逐笔一致。
 */
function wouldExitOnLockedDay(p: ExitPolicy, st: ExitState, today: PathBar, barsSoFar: readonly PathBar[]): ExitReason | null {
  if (st.stopLvl !== null && today.l <= st.stopLvl) return "止损";
  if (p.破均线 !== null) {
    const n = p.破均线;
    if (barsSoFar.length >= n) {
      const ma = barsSoFar.slice(barsSoFar.length - n).reduce((a, b) => a + b.c, 0) / n;
      if (today.c < ma) return "破均线";
    }
  }
  const pnl = st.entry > 0 ? (today.c / st.entry - 1) * 100 : 0;
  if (p.时间止损 !== null && st.held >= p.时间止损.第几日 && pnl <= p.时间止损.低于) return "时间止损";
  if (st.held >= p.到期) return "期满";
  return null;
}

/** 一天结束后更新状态：抬峰值、按峰值重算移动止损。必须在 stepExit 判定之后调用，不改 held */
export function advanceExit(p: ExitPolicy, st: ExitState, today: PathBar): void {
  if (today.h > st.peak) st.peak = today.h;
  const t = p.移动止损;
  if (t !== null && st.entry > 0) {
    const gain = (st.peak / st.entry - 1) * 100;
    if (gain >= t.起) {
      const lvl = st.peak * (1 - t.回撤 / 100);
      st.stopLvl = st.stopLvl === null ? lvl : Math.max(st.stopLvl, lvl);
    }
  }
}

export interface SimOpts {
  /** 已换算到成交日尺度的日线，**从成交日那一根起**，升序 */
  path: readonly PathBar[];
  /**
   * 成交日**之前**的日线（升序，同一尺度）。均线类规则要靠它才算得出当天的 MA。
   *
   * 不给它，破均线规则在入场后永远凑不齐窗口，于是"一条都没触发"——
   * 表现成规则无效（影响面 0.0%），其实是数据没喂进去。
   * 这种假阴性与"规则真的没用"在结果表上长得一模一样，只能靠影响面这一列看出来。
   */
  prior?: readonly PathBar[];
  entryPx: number;
  planStopPx: number | null;
  planTargetPx: number | null;
  slippage: number;
  feeRate: number;
  /**
   * 一字跌停最多顺延几根，超了算走不了。
   * 与 settleShadow 同口径：最后一根可判定的下标 = 到期 − 1 + maxDefer（成交日下标 0）。
   */
  maxDefer?: number;
}

export interface TodayDecision {
  走: boolean;
  /** 触发的那一天（可能早于今天 —— 说明台账里这笔早该离场了） */
  onDate: string | null;
  px: number | null;
  reason: string | null;
  /** 到今天为止持有交易日数 */
  held: number;
  /** 因为缺 openDate 而被关掉的规则名 */
  skipped: string[];
}

/**
 * 判定**今天**该不该走。
 *
 * 这是评测与实盘共用的那一段：评测脚本把它循环调用（dim=simulateExit），
 * 离场器槽每天调用一次。分开写两遍是本项目最要避免的事 ——
 * "按优化出来的参数上线"要求上线跑的就是被优化的那套。
 *
 * @param 盘中 true 表示今天还没收盘：此刻最高价/收盘价都还在动，
 *   收盘类规则（破均线、时间止损、期满）在盘中判等于拿半根 K 线当定稿。
 *   只留盘中止损/目标这两条价格线 —— 它们是"价格到了就走"，不需要当天收完。
 */
export function decideToday(p: ExitPolicy, o: SimOpts & { 盘中?: boolean }): TodayDecision {
  const path = o.path;
  const skipped: string[] = [];
  if (path.length < 2) {
    return { 走: false, onDate: null, px: null, reason: null, held: Math.max(1, path.length), skipped };
  }
  let pol = p;
  if (o.盘中 === true) pol = { ...p, 破均线: null, 时间止损: null, 到期: Number.MAX_SAFE_INTEGER };
  if (pol.到期 === null || !Number.isFinite(pol.到期)) pol = { ...pol, 到期: Number.MAX_SAFE_INTEGER };

  const st = newExitState(pol, o.entryPx, o.planStopPx, o.planTargetPx);
  const seen: PathBar[] = [...(o.prior ?? []), path[0]];
  for (let i = 1; i < path.length; i++) {
    st.held = i + 1;
    const b = path[i];
    const d = stepExit(pol, st, b, path[i - 1].c, seen);
    seen.push(b);
    if (d.走) return { 走: true, onDate: b.date, px: d.px, reason: d.reason, held: st.held, skipped };
    advanceExit(pol, st, b);
  }
  return { 走: false, onDate: null, px: null, reason: null, held: st.held, skipped };
}

/**
 * 从一个政策对象里剔除需要持有天数、或需要"建仓以来那段路径"、但拿不到 openDate 的规则。
 *
 * 缺 openDate 就当"第 1 天"是最危险的默认：时间止损会永远不触发，
 * 而卡片上一切如常，看不出它没生效。这里把规则关掉并把名字报上去，
 * 由调用方写进卡片的 warning。
 *
 * 移动止损也在此列：它的峰值要从建仓日起算，拿不到建仓日就只能拿建仓之前的高点当峰值，
 * 那会凭空抬出一条止损线、在建仓前的走势上判清仓。破均线只看"今天收盘 vs 均线"，不需要建仓日。
 */
export function dropRulesNeedingAge(p: ExitPolicy): { pol: ExitPolicy; dropped: string[] } {
  const dropped: string[] = [];
  const out = { ...p };
  if (out.到期 !== null && Number.isFinite(out.到期) && out.到期 < Number.MAX_SAFE_INTEGER) { dropped.push("持有上限"); out.到期 = Number.MAX_SAFE_INTEGER; }
  if (out.时间止损 !== null) { dropped.push("时间止损"); out.时间止损 = null; }
  if (out.移动止损 !== null) { dropped.push("移动止损"); out.移动止损 = null; }
  return { pol: out, dropped };
}

/** 与 settleShadow 用同一个取整：两份实现要产出同一个数字，不只是"差得很少" */
const r6 = (x: number): number => Math.round(x * 1e6) / 1e6;

/**
 * status 的取值**刻意与 settleShadow 完全一致**（已结算 / 待定）。
 *
 * 本模块不算"是否成交"（那由 settleShadow 在进场那一步处理），所以没有它的"未触发"；
 * 余下两个用同名同义。若这里自造一个 "走不了"，每次跨口径比较都要记住一条映射关系，
 * 而这条映射迟早被漏掉一次。
 */
export interface SimResult {
  status: "已结算" | "待定";
  netPct: number | null;
  exitIdx: number | null;
  reason: string | null;
  /** 持有交易日数（成交日算 1） */
  held: number | null;
  /** 待定的原因。不给键盘理由的待定等于把"没数据"和"没问题"混在一起 */
  note: string | null;
}

/**
 * 沿路径推进到离场为止。
 *
 * 成交日那一根不参与判定（T+1），所以从第 2 根开始调用 stepExit。
 */
export function simulateExit(p: ExitPolicy, o: SimOpts): SimResult {
  const path = o.path;
  if (path.length < 2) {
    return { status: "待定", netPct: null, exitIdx: null, reason: null, held: null, note: "成交日之后还没有 K 线（停牌或未到）" };
  }
  const st = newExitState(p, o.entryPx, o.planStopPx, o.planTargetPx);
  const seen: PathBar[] = [...(o.prior ?? []), path[0]];
  // settleShadow: lastIdx = horizon − 1 + maxDefer。早些版本写成 到期 + maxDefer，多推一根
  const lastIdx = p.到期 - 1 + (o.maxDefer ?? 10);
  for (let i = 1; i < path.length; i++) {
    if (i > lastIdx) break;
    const b = path[i];
    st.held = i + 1; // 含当日的持有天数：成交日 = 1
    const d = stepExit(p, st, b, path[i - 1].c, seen);
    seen.push(b);
    if (d.走) {
      const s = o.slippage, f = o.feeRate;
      const net = ((d.px * (1 - s) * (1 - f)) / (o.entryPx * (1 + s) * (1 + f)) - 1) * 100;
      // 与 settleShadow 同为 r6：两份实现要产出**同一个数字**，不只是"差得很少"。
      // 差 5e-8 今天无害，但它会让"是否逐笔一致"这个判据退化成一个要人拿捏阈值的主观问题。
      return { status: "已结算", netPct: r6(net), exitIdx: i, reason: d.reason, held: st.held, note: null };
    }
    advanceExit(p, st, b);
  }
  const note = st.deferred !== null ? `一字跌停卖不出，顺延（${st.deferred}）` : "持有期还没走完";
  return { status: "待定", netPct: null, exitIdx: null, reason: null, held: null, note };
}

/**
 * 原始 K 线的最小形状。
 *
 * 刻意不用 DailyBar：脚本从库里取的是"只够算价格的几列"（code / vol / amount 用不上），
 * 为了拿去喂 scalePath 还得把那几列补齐或用 `as any` 换过去 —— 与其让调用方造假数据，
 * 不如这里声明真正用到的那几列。
 */
export interface RawBar {
  date: string;
  o: number; h: number; l: number; c: number;
  /** 复权因子。缺失当 1 */
  adjFactor?: number | undefined;
}

/**
 * 把一段原始 K 线换算到第 `baseIdx` 根的价格尺度（默认第 0 根）。
 *
 * `baseIdx` 必须是**成交日那一根**的下标。
 * 若传入一整段从入场日之前开始的窗口却用默认 0，就会把价格归一到最老那根，
 * 一旦窗口内有分红送股，整条价格相对入场价就被整体缩放，
 * 而入场价是台账里的固定数字、不会被缩放 —— 于是每笔都差一点，
 * 且只在部分股票上出现（自检 4637 笔里错了 538 笔，全是这类票）。
 */
export function scalePath(raw: readonly RawBar[], baseIdx = 0): PathBar[] {
  if (raw.length === 0) return [];
  const b0 = raw[Math.max(0, Math.min(baseIdx, raw.length - 1))];
  const f0 = (b0.adjFactor ?? 1) > 0 ? (b0.adjFactor ?? 1) : 1;
  return raw.map(b => {
    const adj = (b.adjFactor ?? 1) > 0 ? (b.adjFactor ?? 1) : 1;
    const s = (x: number) => (x * adj) / f0;
    return { date: b.date, o: s(b.o), h: s(b.h), l: s(b.l), c: s(b.c), adjFactor: adj };
  });
}
