import type { Db } from "@/lib/db";
import type { Action, ErrorType, Prediction, Verdict } from "@/lib/contracts";
import { PRED_COLS, toPrediction, type PredictionRow } from "@/lib/ledger/query";
import { settleOne, type SettleFacts } from "@/lib/ledger/reconcile";

/**
 * 错误聚类（spec §11 第 3 步）。
 *
 * 枚举是闭的，且故意不留自由文本口子：自由描述的错误没法计数，
 * 而"某类错误达到多少次 → 提哪个参数建议"这条链完全靠计数驱动。
 * 归不进四类的一律落 其他 —— 其他 占比高本身就是信号（说明规则库还没覆盖到）。
 *
 * 四类都来自真实复盘：
 *   瞬时价误判 —— 用旧缓存价 / 盘中抖动价下的判断
 *   板块漏扫   —— 主线在必查链里却没扫到（2026-07-27 主线级漏扫）
 *   逆势扛     —— 破止损没走
 *   追高       —— 在位置涨幅上限外买入
 */

/** 决策报价超过 5 分钟就算陈旧：速判必须当场刷实时价，复用旧缓存是复发过的错 */
export const STALE_QUOTE_MAX_SEC = 300;

/** 信号价与基准收盘偏离超 3% —— A股日内正常波动内，偏这么多多半是拿了抖动价 */
export const DECISION_PX_DEV_MAX_PCT = 3;

/** 位置涨幅上限默认值，实际应由 strategy.yaml 的 选股.过滤器阈值.位置涨幅上限 覆盖 */
export const DEFAULT_RUNUP_CAP_PCT = 30;

/** 买前涨幅的回看窗口（交易日） */
export const RUNUP_LOOKBACK_DAYS = 20;

export interface AttributionInput {
  verdict: Verdict;
  action: Action;
  /** 决策所用报价的陈旧度（秒）。null = 无从判断，规则就不触发，不硬猜 */
  quoteAgeSec: number | null;
  /** 信号价相对基准收盘的偏离（%）。null = 该信号没给触发价 */
  decisionPxDeviationPct: number | null;
  /** 事后确认的主线板块 */
  mainlineSector: string | null;
  /** strategy.yaml 的 选股.主线识别.必查链 */
  mandatoryChain: string[];
  /** 当次实际扫过的板块。null = 没留痕，漏扫规则无法判定 */
  scannedSectors: string[] | null;
  stopBreached: boolean;
  /** 破位之后台账里是否出过减仓/清仓信号 */
  exitSignalAfterBreach: boolean;
  /** 买入前的累计涨幅（%） */
  priorRunupPct: number | null;
  runupCapPct: number;
}

export interface AttributionResult {
  errorType: ErrorType | null;
  attribution: string;
  /** 命中的规则名，便于回看是哪条判的；落 其他 时为 null */
  rule: string | null;
}

function isBuy(a: Action): boolean {
  return a === "买入" || a === "加仓";
}

function isLong(a: Action): boolean {
  return isBuy(a) || a === "持有";
}

/**
 * 归因。只归"偏差"，命中和中性不归错因 —— 给命中的单子编错因会污染频次统计。
 *
 * 优先级按根因深浅排（越靠前越致命）：
 *   1 瞬时价误判：输入价就是错的，后面所有推理都不成立
 *   2 板块漏扫：根本没看到主线，谈不上选错票
 *   3 追高：看到了、买了，但违反了入场位置规则
 *   4 逆势扛：入场没问题，是离场纪律没执行
 * 多条同时成立时只记最靠前的那条，因为参数建议一次只该改一个地方。
 */
export function classifyError(input: AttributionInput): AttributionResult {
  if (input.verdict !== "偏差") {
    return { errorType: null, attribution: `判定为${input.verdict}，不归错因`, rule: null };
  }

  if (input.quoteAgeSec != null && input.quoteAgeSec > STALE_QUOTE_MAX_SEC) {
    return {
      errorType: "瞬时价误判",
      attribution: `决策所用报价已陈旧 ${Math.round(input.quoteAgeSec)}s（上限 ${STALE_QUOTE_MAX_SEC}s），判断建立在旧价上`,
      rule: "报价陈旧",
    };
  }
  if (input.decisionPxDeviationPct != null
      && Math.abs(input.decisionPxDeviationPct) > DECISION_PX_DEV_MAX_PCT) {
    return {
      errorType: "瞬时价误判",
      attribution: `信号价偏离基准收盘 ${input.decisionPxDeviationPct.toFixed(2)}%（上限 ±${DECISION_PX_DEV_MAX_PCT}%），疑似用了盘中抖动价`,
      rule: "信号价偏离",
    };
  }

  if (input.mainlineSector && input.scannedSectors
      && input.mandatoryChain.includes(input.mainlineSector)
      && !input.scannedSectors.includes(input.mainlineSector)) {
    return {
      errorType: "板块漏扫",
      attribution: `主线 ${input.mainlineSector} 在必查链内但本次未扫到（已扫：${input.scannedSectors.join("、") || "无"}）`,
      rule: "必查链漏扫",
    };
  }

  if (isBuy(input.action) && input.priorRunupPct != null
      && input.priorRunupPct > input.runupCapPct) {
    return {
      errorType: "追高",
      attribution: `买入前已累计上涨 ${input.priorRunupPct.toFixed(1)}%，超出位置涨幅上限 ${input.runupCapPct}%`,
      rule: "位置涨幅超限",
    };
  }

  if (isLong(input.action) && input.stopBreached && !input.exitSignalAfterBreach) {
    return {
      errorType: "逆势扛",
      attribution: "已破止损，且此后台账中未出现减仓/清仓信号",
      rule: "破止损未离场",
    };
  }

  return {
    errorType: "其他",
    attribution: "现有线索不足以归入四类固定错因，待人工复盘补充",
    rule: null,
  };
}

export interface AttributionContext {
  /** 事后确认的主线板块。库里没有"当日主线"这张表，只能由复盘时传入 */
  mainlineSector?: string | null;
  mandatoryChain?: string[];
  /** 当次扫过的板块。扫描留痕不在台账职责内，同样由调用方传 */
  scannedSectors?: string[] | null;
  runupCapPct?: number;
}

/**
 * 把库里能算出来的事实取齐。
 *
 * 板块漏扫必须靠 ctx：没有哪张表记录"这次扫了哪些板块"，
 * 不传 ctx 时该规则永远不触发 —— 宁可漏判也不臆造扫描记录。
 */
export function buildAttributionInput(
  db: Db, p: Prediction, facts: SettleFacts, verdict: Verdict, ctx: AttributionContext = {}
): AttributionInput {
  // 决策时刻之前离得最近的一笔快照，用它的年龄衡量"当时手上的价有多旧"
  const snap = db.prepare(
    `SELECT ts FROM quote_snapshot WHERE code = ? AND ts <= ? ORDER BY ts DESC LIMIT 1`
  ).get(p.code, new Date(Date.parse(p.ts)).toISOString()) as { ts: string } | undefined;
  const quoteAgeSec = snap
    ? Math.max(0, (Date.parse(p.ts) - Date.parse(snap.ts)) / 1000)
    : null;

  const decisionPxDeviationPct = p.triggerPx != null && facts.base.px > 0
    ? ((p.triggerPx - facts.base.px) / facts.base.px) * 100
    : null;

  // 买前涨幅：基准价相对回看窗口内最低价的涨幅
  const low = db.prepare(
    `SELECT MIN(l) v FROM (
       SELECT l FROM kline_daily WHERE code = ? AND date <= ? AND l IS NOT NULL
       ORDER BY date DESC LIMIT ?)`
  ).get(p.code, facts.base.date, RUNUP_LOOKBACK_DAYS) as { v: number | null } | undefined;
  const priorRunupPct = low?.v != null && low.v > 0
    ? ((facts.base.px - low.v) / low.v) * 100
    : null;

  // 破位之后有没有出过离场信号 —— 有，就是有纪律；没有，才是"扛"
  let exitSignalAfterBreach = false;
  if (facts.stopBreachDate) {
    const row = db.prepare(
      `SELECT 1 FROM prediction WHERE code = ? AND action IN ('清仓','减仓')
         AND substr(ts,1,10) >= ? AND substr(ts,1,10) <= ? LIMIT 1`
    ).get(p.code, facts.stopBreachDate, facts.horizonEnd);
    exitSignalAfterBreach = !!row;
  }

  return {
    verdict,
    action: p.action,
    quoteAgeSec,
    decisionPxDeviationPct,
    mainlineSector: ctx.mainlineSector ?? null,
    mandatoryChain: ctx.mandatoryChain ?? [],
    scannedSectors: ctx.scannedSectors ?? null,
    stopBreached: facts.stopBreached,
    exitSignalAfterBreach,
    priorRunupPct,
    runupCapPct: ctx.runupCapPct ?? DEFAULT_RUNUP_CAP_PCT,
  };
}

/**
 * 给已结算的 outcome 补错因。
 *
 * 归因是追加，不覆盖：对账事实（价源、区间、涨跌幅）必须原样留着，
 * 否则将来发现归因规则判错了，连当初的事实都没法复查。
 */
export function attributeOutcome(
  db: Db, predId: string, ctx: AttributionContext = {}
): AttributionResult | null {
  const row = db.prepare(
    `SELECT ${PRED_COLS}, o.verdict, o.attribution FROM prediction p
     JOIN outcome o ON o.pred_id = p.id WHERE p.id = ?`
  ).get(predId) as (PredictionRow & { verdict: Verdict; attribution: string }) | undefined;
  if (!row) return null;

  const p = toPrediction(row);
  const att = settleOne(db, p, {});
  if (!att.ok || !att.facts) return null;

  const res = classifyError(buildAttributionInput(db, p, att.facts, row.verdict, ctx));
  const merged = row.attribution?.includes(res.attribution)
    ? row.attribution
    : `${row.attribution ?? ""}｜${res.errorType ?? "无错因"}：${res.attribution}`;
  db.prepare("UPDATE outcome SET error_type = ?, attribution = ? WHERE pred_id = ?")
    .run(res.errorType, merged, predId);
  return res;
}

/** 批量补错因：对账 job 之后跑一遍，把当天新结算的偏差都归类 */
export function attributeSettled(
  db: Db, opts: { from?: string; to?: string; ctx?: AttributionContext } = {}
): { attributed: number; byErrorType: Record<string, number> } {
  const ids = db.prepare(
    `SELECT p.id FROM prediction p JOIN outcome o ON o.pred_id = p.id
     WHERE o.verdict = '偏差' AND o.error_type IS NULL
       AND substr(p.ts,1,10) >= COALESCE(?, '0000-00-00')
       AND substr(p.ts,1,10) <= COALESCE(?, '9999-99-99')
     ORDER BY p.ts`
  ).all(opts.from ?? null, opts.to ?? null).map((r: any) => r.id as string);

  const byErrorType: Record<string, number> = {};
  let attributed = 0;
  for (const id of ids) {
    const r = attributeOutcome(db, id, opts.ctx);
    if (!r?.errorType) continue;
    byErrorType[r.errorType] = (byErrorType[r.errorType] ?? 0) + 1;
    attributed++;
  }
  return { attributed, byErrorType };
}
