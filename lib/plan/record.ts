import type { Db } from "@/lib/db";
import { entryTypeOf, type Candidate, type EnvAssessment, type Prediction, type SignalCard } from "@/lib/contracts";
import type { FactorResult } from "@/lib/contracts/factor";
import { recordPredictions } from "@/lib/ledger/record";
import { baseTradingDay, TRIGGER_WINDOW_DAYS, tradingDayOffset } from "@/lib/ledger/reconcile";
// isLateDecision / toShanghaiWall 来自 clock（reconcile 也是从那儿引的），不在 reconcile 导出里
import { addDays, isLateDecision, toShanghaiWall } from "@/lib/data/clock";
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

/** 无账户止损价时，买入/加仓兜底止损比例（8%）。风控底线，避免空止损落台账。 */
const DEFAULT_STOP_PCT = 0.08;

/**
 * 止盈比例（+5%）。此前系统只有止损没有止盈，成交后一路拿到期满。
 *
 * 依据（2026-10-23，影子盘 12,665 条可重放样本，按基准日 7:3 时间切分，
 * 扣 0.15% 双边成本后的样本外每信号净期望）：
 *
 *   纯期满    +0.097%
 *   止盈 4%   +0.209%   ← 最高
 *   止盈 5%   +0.195%
 *   止盈 8%   +0.182%
 *
 * 取 5% 而不是最高的 4%：4/5/8 是一片平台，差在噪音里，取中间一档两边都有邻档支撑；
 * 而 4% 是网格里的最优点，本身带着"挑过"的运气（selectionBias 已在报）。
 * 止损那条轴实测无效，不在这里动它。
 */
const DEFAULT_TAKE_PROFIT_PCT = 0.05;

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
  card: SignalCard, date: string, ts: string, horizon: EvalHorizon, validUntil: string,
  strategyVersion: string | null = null
): Prediction[] {
  return [...card.candidates, ...card.holdings].map((c) => {
    // 风控兜底：买入/加仓若账户没配止损价（structure-pricing 评估器会因此把这类票排最后），
    // 不能让它空着落台账 —— 空止损意味着没有纪律底线。用触发价默认 -8% 兜底，并在 thesis 标注。
    const needsStop = c.action === "买入" || c.action === "加仓";
    const stopPx = c.stopPx ?? (needsStop && c.triggerPx != null
      ? Math.round(c.triggerPx * (1 - DEFAULT_STOP_PCT) * 1e4) / 1e4 : null);
    const thesis = (!c.stopPx && needsStop && c.triggerPx != null)
      ? `${c.thesis}（无账户止损价，已用默认 -${(DEFAULT_STOP_PCT * 100).toFixed(0)}% 兜底）`
      : c.thesis;
    // 止盈只对"会形成仓位"的动作有意义：清仓/减仓是减持仓，观察没有方向承诺
    const takeProfitPx = (c.action === "买入" || c.action === "加仓") && c.triggerPx != null
      ? Math.round(c.triggerPx * (1 + DEFAULT_TAKE_PROFIT_PCT) * 1e4) / 1e4 : null;
    return {
      id: planPredictionId(date, card.strategyId, c.code, c.action),
      ts,
      phase: card.phase,
      code: c.code,
      strategyId: card.strategyId,
      // 版本逐条记：买点这类参数要按台账数据反复重调，
      // 不记版本的话下一次调参就把两代样本混进同一个分母了
      strategyVersion,
      action: c.action,
      account: c.account,
      triggerPx: c.triggerPx,
      // 打板 / 半路这类触发价在昨收上方的是触价单，结算按"最高价 ≥ 触发价"撮合（见 EntryType）
      entryType: entryTypeOf(c.entryType),
      stopPx,
      takeProfitPx,
      size: c.size,
      thesis,
      gear: card.env.gear,
      evalHorizon: horizon,
      validUntil,
      // 引擎自己声明有没有被 Advisor 改过。这里绝不默认 false ——
      // 默认值会把"有 Claude 参与"的样本混进对照组，A/B 差值就是假的
      advisorInfluenced: card.advisorInfluenced,
    };
  });
}

/** prediction_factor 一行：一条推荐在某个因子上的当场读数 */
export interface PredictionFactorRow {
  predId: string;
  factorName: string;
  scope: "stock" | "env";
  version: string | null;
  value: number | null;
  label: string | null;
  confidence: number | null;
  createdAt: string;
}

function factorToRow(
  predId: string, scope: "stock" | "env", f: FactorResult<any>, createdAt: string
): PredictionFactorRow {
  return {
    predId,
    factorName: f.name,
    scope,
    version: f.version ?? null,
    // 定性因子只给 label（value 是字符串或对象），数值列留 NULL ——
    // 硬转成 0 会让后面的 IC 把"没读数"当成"读数=0"，凭空造出一个假的低分组
    value: typeof f.value === "number" && Number.isFinite(f.value) ? f.value : null,
    label: f.label ?? null,
    confidence: typeof f.confidence === "number" ? f.confidence : null,
    createdAt,
  };
}

/**
 * 信号卡 → 因子读数行。
 *
 * 这是"台账能被逐因子归因"的开关：引擎早就算出了完整因子数组（Candidate.factors），
 * 但以前只把它们拼进 thesis 字符串就丢了，于是 IC / 分位数分组 / 横截面回归
 * 全都无从下手 —— 不知道当时每个因子读数是多少，就只能继续拍权重。
 *
 * 环境因子（温度、涨停家数、炸板率…）是整张卡共用的，这里摊到每条推荐上：
 * 归因时要的是"这条推荐发出时的市场环境"，它必须和这条推荐在同一行才算得出来。
 * 体积可以忽略（一天几十条推荐 × 十来个因子）。
 */
export function planFactorRows(
  date: string, strategyId: string, cands: Candidate[], env: EnvAssessment, createdAt: string
): PredictionFactorRow[] {
  const rows: PredictionFactorRow[] = [];
  for (const c of cands) {
    const predId = planPredictionId(date, strategyId, c.code, c.action);
    for (const f of c.factors ?? []) rows.push(factorToRow(predId, "stock", f, createdAt));
    for (const f of env.factors ?? []) rows.push(factorToRow(predId, "env", f, createdAt));
  }
  return rows;
}

/** 写入因子读数行。幂等：同 (pred_id, factor_name, scope) 已存在就跳过，不改写 */
export function recordFactorRows(db: Db, rows: PredictionFactorRow[]): number {
  if (rows.length === 0) return 0;
  const stmt = db.prepare(
    `INSERT INTO prediction_factor
       (pred_id, factor_name, scope, version, value, label, confidence, created_at)
     VALUES (?,?,?,?,?,?,?,?)
     ON CONFLICT(pred_id, factor_name, scope) DO NOTHING`
  );
  let n = 0;
  db.transaction(() => {
    for (const r of rows) {
      n += stmt.run(
        r.predId, r.factorName, r.scope, r.version, r.value, r.label, r.confidence, r.createdAt
      ).changes;
    }
  })();
  return n;
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
  horizon: EvalHorizon = PLAN_EVAL_HORIZON,
  strategyVersion: string | null = null
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
  /**
   * 决策已过集合竞价 → 这批推荐不可执行，整批不记。
   *
   * 守护进程没起来 / 机器睡过头时，补跑出来的 ts 是真实的晚点，于是成交日就是
   * 当天、而当天的 09:25 早已过去 —— 记进去 reconcile 会整批判"作废"：
   * 既不进任何统计、又占掉当天批次，还让"今天出了 N 条推荐"在界面上看着像真出过票。
   * 实测 2026-10-08/09 两批（13:39 / 12:10 生成）就是这样变成 14 条僵尸行的，
   * 并把"作废率"这个弱点指标抬到虚高，误导了复盘结论。
   *
   * **不把 ts 硬写成 09:15 来绕过**：那时段根本没做决策，写成 09:15 是撒谎，
   * 而且会把一批根本没发生过的交易混进统计 —— 胜率会被它们带偏。
   * 成交日算法复用 baseTradingDay，不在这里另立一套。
   */
  const base = baseTradingDay(db, { ts, phase: card.phase });
  const fillDay = base === null ? null : tradingDayOffset(db, base, TRIGGER_WINDOW_DAYS);
  if (fillDay !== null && isLateDecision(ts, fillDay)) {
    return {
      recorded: 0, skipped: true, ids: [], alreadyRecorded: false,
      reason: `决策时点 ${toShanghaiWall(ts)} 晚于成交日 ${fillDay} 09:25 集合竞价，本批不可执行（不伪造 ts），整批不进台账`,
    };
  }

  const validUntil = planValidUntil(db, date, horizon);
  const preds = planPredictions(card, date, ts, horizon, validUntil, strategyVersion);
  if (preds.length === 0) return { recorded: 0, skipped: false, ids: [], validUntil };

  recordPredictions(db, preds);
  // 因子读数与推荐绑定落库：prediction 只留了 thesis 字符串，
  // 没有逐因子读数就永远算不出 IC，权重只能继续手拍（见 planFactorRows 注释）
  recordFactorRows(
    db, planFactorRows(date, card.strategyId, [...card.candidates, ...card.holdings], card.env, ts)
  );
  return { recorded: preds.length, skipped: false, ids: preds.map((p) => p.id), validUntil };
}
