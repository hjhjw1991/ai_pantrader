import type { Db } from "@/lib/db";
import type { Prediction, SignalCard } from "@/lib/contracts";
import { recordPredictions } from "@/lib/ledger/record";
import { tradingDayOffset } from "@/lib/ledger/reconcile";
import { addDays } from "@/lib/data/clock";
import type { EvalHorizon } from "@/lib/ledger/query";

/**
 * 把盘前信号卡落进台账。
 *
 * 这一步以前是**故意不做**的（见 preopen.ts 的旧注释）：往 prediction 表写东西
 * 等于宣告"策略做了这些预测，请按它们统计胜率"，那是一个独立的决定。
 * 现在这个决定做了 —— 目标是量出"推荐的买点到不到得了、盈亏比多少、胜率有没有过 60%"，
 * 而不落台账就永远没有样本可量（实测：台账自建成起 prediction 一直是 0 行）。
 *
 * 三条纪律：
 *
 * 1. **只在盘前记一次**。盘中扫描每 5 分钟跑一轮，但它读的是同一份截至昨收的数据，
 *    出的是同一批候选。每轮都记等于把同一条推荐复制几十份，胜率会被这批复制品
 *    加权成"那天那几只票的表现"，而不是策略的表现。
 *
 * 2. **id 由内容推导，不用随机数**。job 重跑（唤醒补偿、手动触发、进程重启）很正常，
 *    recordPrediction 对同 id 同内容是幂等的，对同 id 不同内容直接报错 ——
 *    正好是台账该有的性质：允许重投，不允许改写。
 *
 * 3. **事前记，不事后补**。record.ts 的注释已经写明：事后补记等于事后选样本，
 *    胜率会自动变好看。所以这里在 09:15 出计划的同一时刻写入，
 *    不提供任何"把昨天的候选补记进来"的入口。
 */

/**
 * 判定期限。
 *
 * 取 5 个交易日：这套策略的候选来自涨停池 / 主线领涨 / 量价突破，
 * 持有周期本来就是几天量级，用 D20/D30 去判它等于在问一个它没打算回答的问题。
 * D5 同时对齐龙虎榜自带的 d5_chg 标签，reconcile 拿它做交叉校验（见 lhbLabelPct）。
 *
 * 改这个值会让新旧样本不可比 —— 同一条推荐按 D1 和按 D10 判，胜率完全是两回事。
 * 真要改，应该新起一个 strategyId 版本，让两批样本在台账里天然分开。
 */
export const PLAN_EVAL_HORIZON: EvalHorizon = 5;

export interface RecordPlanResult {
  recorded: number;
  /** 保留字段：整批不写的情形。目前只有空卡会走到 recorded=0 而 skipped=false */
  skipped: boolean;
  reason?: string;
  ids: string[];
  /** 这批的到期日，便于日志里看出用的是交易日还是自然日估算 */
  validUntil?: string;
  /** 今天这批已经记过了，本次什么都没写 */
  alreadyRecorded?: boolean;
}

/**
 * 一天一批，id 稳定：`日期:策略:代码:动作`。
 * 同一只票同一天不会既"买入"又"加仓"（引擎对每个 code 只出一条），
 * 带上 action 只是为了 id 自解释，出问题时不用回查库就知道这条是什么。
 */
export function planPredictionId(date: string, strategyId: string, code: string, action: string): string {
  return `${date}:${strategyId}:${code}:${action}`;
}

/**
 * 信号卡 → 台账行。
 *
 * 整卡都记（candidates + holdings），不只记买入：
 * 减仓/清仓/持有 同样是有方向承诺的判断，directionOf 早就把它们映射好了。
 * 只记买入会让台账只在上涨方向上被检验，防守做得对不对永远看不出来。
 *
 * 观察 类动作没有方向承诺，reconcile 会判成中性、不进胜率分母 —— 照记不误，
 * 因为"这周出了多少条只能观察的信号"本身就是复盘要看的东西。
 */
export function planPredictions(
  card: SignalCard, date: string, ts: string, horizon: EvalHorizon, validUntil: string
): Prediction[] {
  return [...card.candidates, ...card.holdings].map((c) => ({
    id: planPredictionId(date, card.strategyId, c.code, c.action),
    ts,
    phase: card.phase,
    code: c.code,
    strategyId: card.strategyId,
    action: c.action,
    account: c.account,
    triggerPx: c.triggerPx,
    stopPx: c.stopPx,
    size: c.size,
    thesis: c.thesis,
    gear: card.env.gear,
    evalHorizon: horizon,
    validUntil,
    // 引擎自己声明有没有被 Advisor 改过。这里绝不默认 false ——
    // 默认值会把"有 Claude 参与"的样本混进对照组，A/B 差值就是假的
    advisorInfluenced: card.advisorInfluenced,
  }));
}

/**
 * 到期日。
 *
 * 优先用交易日历推 —— 精确，且横跨长假时不会算早。
 * 但**生产环境几乎总是走不到这条路**：交易日历是从已落库的行情日期反推的
 * （见 lib/data/calendar），它最远只到今天，不可能知道未来 5 个交易日是哪几天。
 * 实测生产库 trading_calendar 的 MAX(date) 就是当天。
 * 早先这里直接返回 null 拒绝写入，结果是盘前计划永远落不了台账 —— 静默失效。
 *
 * 所以退回自然日估算：5 个交易日 ≈ 7 个自然日，再加 3 天余量兜住小长假。
 *
 * 估早估晚都不会出错，这是关键：valid_until 只是"什么时候去看看它到期没有"的
 * 调度提示，真正的 horizon 末日由 settleOne 在结算那一刻用当时的日历重算。
 * 估早 → settleOne 报"日历不足"，留 pending，明晚再来（reconcile 幂等）；
 * 估晚 → 结算晚一两天。两种都自我纠正，而拒绝写入不会。
 */
export function planValidUntil(db: Db, date: string, horizon: EvalHorizon): string {
  return tradingDayOffset(db, date, horizon)
    ?? addDays(date, Math.ceil((horizon * 7) / 5) + 3);
}

/** 今天这个策略已经记过一批没有 */
function alreadyRecordedToday(db: Db, date: string, strategyId: string): boolean {
  const r = db.prepare(
    `SELECT 1 FROM prediction WHERE substr(ts,1,10) = ? AND strategy_id = ? LIMIT 1`
  ).get(date, strategyId);
  return r !== undefined;
}

export function recordPlan(
  db: Db, card: SignalCard, date: string, ts: string,
  horizon: EvalHorizon = PLAN_EVAL_HORIZON
): RecordPlanResult {
  /**
   * 先查今天记过没有，而不是靠 recordPrediction 的幂等去兜。
   *
   * 因为幂等的判据是**内容指纹**，而指纹含 ts —— job 重跑（唤醒补偿、手动触发、
   * 进程重启）时挂钟时间必然不同，于是同 id 不同内容，直接抛 LedgerConflictError。
   * 那正是台账该有的性质（不许改写），但用在这里就变成了"重跑必炸"。
   *
   * 也不把 ts 硬写成 09:15 来绕开：job 实际在 10:30 补跑时记成 09:15 是撒谎，
   * 而且会和 phase（那时已是"盘中"）互相矛盾。
   *
   * 所以在批次这一层去重：一天一批，已经有了就整批跳过，如实说明。
   */
  if (alreadyRecordedToday(db, date, card.strategyId)) {
    return {
      recorded: 0, skipped: true, alreadyRecorded: true, ids: [],
      reason: `${date} 已记过一批（策略 ${card.strategyId}），台账只追加不改写`,
    };
  }
  const validUntil = planValidUntil(db, date, horizon);
  const preds = planPredictions(card, date, ts, horizon, validUntil);
  if (preds.length === 0) return { recorded: 0, skipped: false, ids: [], validUntil };

  recordPredictions(db, preds);
  return { recorded: preds.length, skipped: false, ids: preds.map((p) => p.id), validUntil };
}
