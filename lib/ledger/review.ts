import type { Db } from "@/lib/db";
import type { Verdict } from "@/lib/contracts";
import { countsTowardWinRate } from "@/lib/contracts";
import { predWhere, round, type LedgerFilter } from "@/lib/ledger/query";

/**
 * 推荐质量复盘（本文件是"胜率>60%"这个目标的唯一口径来源）。
 *
 * 回答三件事，而且必须**分开**回答：
 *   1. 触发率 —— 推荐的买点，价格到底到没到
 *   2. 胜率   —— 到了之后，判对的比例（只在触发样本里算）
 *   3. 盈亏比 —— 到了之后，赢的时候赚多少、输的时候亏多少
 *
 * 为什么分开：这三个数会互相掩盖。
 * 一个"触发率 10%、胜率 80%"的策略，单看胜率是满分，实际一年也做不了几笔；
 * 一个"胜率 65%、盈亏比 0.3"的策略，胜率达标却是稳定亏钱的 ——
 * 赢 10 次每次赚 1%，输 5 次每次亏 5%。
 * 所以最后还要给一个把三者合起来的期望值，避免只盯着达标的那一个数。
 *
 * 分母口径与 winrate.ts 完全一致（countsTowardWinRate），不在这里另立一套。
 */

/** 用户设定的胜率目标线 */
export const WIN_RATE_TARGET = 0.6;

/**
 * 判断"达标/不达标"至少要多少个触发样本。
 *
 * 取 30：胜率在 60% 附近时标准误 ≈ sqrt(0.6*0.4/n)，n=30 约 8.9pp，
 * 也就是说 30 条样本量出来的 60% 真值可能在 42%~78% 之间。
 * 这不是"到 30 就可信"，而是"不到 30 连达标与否都不该下结论" ——
 * 拿 5 条样本的 80% 去调参数，调的是噪声。
 */
export const MIN_SAMPLE = 30;

export interface ReviewStats {
  /** 已结算的推荐总数（含未触发） */
  settled: number;

  /** ── 第 1 关：到不到得了买点 ── */
  /** 有触发判定的条数（排除无 trigger_px 的无条件动作） */
  triggerable: number;
  triggered: number;
  /** triggered / triggerable；triggerable=0 时为 null，不编 0 */
  triggerRate: number | null;

  /** ── 第 2 关：判得准不准（只在触发样本里算） ── */
  /** 进胜率分母的条数：命中 + 偏差 */
  decided: number;
  hit: number;
  winRate: number | null;
  neutral: number;

  /** ── 第 3 关：赚赔比 ── */
  avgWinPct: number | null;
  avgLossPct: number | null;
  /** 平均盈利 / 平均亏损的绝对值。无亏损样本时为 null，不写 Infinity */
  payoffRatio: number | null;
  /** 单条推荐的区间极值均值，用来判断止损设得松还是紧 */
  avgMfePct: number | null;
  avgMaePct: number | null;

  /** ── 合起来看 ── */
  /** 每条已触发推荐的期望收益率（%）= 胜率×均盈 + (1−胜率)×均亏 */
  expectancyPct: number | null;
  /** 每条**发出的**推荐的期望收益率（%）= 触发率 × expectancyPct，含够不到的那些 */
  expectancyPerSignalPct: number | null;

  /** ── 结论 ── */
  /** 样本够不够下结论 */
  conclusive: boolean;
  minSample: number;
  target: number;
  /** 达标 / 未达标 / 样本不足，一句话给人看 */
  verdict: string;
}

interface Row {
  verdict: string;
  actual_pct: number | null;
  triggered: number | null;
  mfe_pct: number | null;
  mae_pct: number | null;
}

const avg = (xs: number[]): number | null =>
  xs.length === 0 ? null : round(xs.reduce((a, b) => a + b, 0) / xs.length, 6);

export function review(db: Db, filter: LedgerFilter = {}): ReviewStats {
  const w = predWhere(filter);
  const rows = db.prepare(
    `SELECT o.verdict, o.actual_pct, o.triggered, o.mfe_pct, o.mae_pct
     FROM prediction p JOIN outcome o ON o.pred_id = p.id
     WHERE 1=1${w.sql}`
  ).all(...w.params) as Row[];

  let triggerable = 0, triggered = 0, decided = 0, hit = 0, neutral = 0;
  const wins: number[] = [], losses: number[] = [], mfes: number[] = [], maes: number[] = [];

  for (const r of rows) {
    // triggered 为 NULL = 无条件动作（清仓类），触发这件事对它不适用，
    // 放进分母会把触发率拉高，掩盖真正够不到的那些
    if (r.triggered !== null) {
      triggerable++;
      if (r.triggered === 1) triggered++;
    }
    if (r.mfe_pct != null) mfes.push(r.mfe_pct);
    if (r.mae_pct != null) maes.push(r.mae_pct);

    if (!countsTowardWinRate(r.verdict as Verdict)) {
      if (r.verdict === "中性") neutral++;
      continue;
    }
    decided++;
    if (r.verdict === "命中") hit++;

    // 盈亏分组按**实际盈亏的符号**，不按判定 ——
    // 判定带中性带，命中的一定赚但偏差的不一定亏到带外那么多，
    // 用判定分组算出来的盈亏比是在量中性带宽度，不是在量赚赔
    if (r.actual_pct != null) {
      if (r.actual_pct > 0) wins.push(r.actual_pct);
      else if (r.actual_pct < 0) losses.push(r.actual_pct);
    }
  }

  const triggerRate = triggerable > 0 ? round(triggered / triggerable, 6) : null;
  const winRate = decided > 0 ? round(hit / decided, 6) : null;
  const avgWinPct = avg(wins);
  const avgLossPct = avg(losses);
  const payoffRatio = avgWinPct != null && avgLossPct != null && avgLossPct !== 0
    ? round(avgWinPct / Math.abs(avgLossPct), 6)
    : null;

  // 期望值用**真实的盈亏样本比例**（wins / (wins+losses)），不用 winRate ——
  // winRate 的分母排除了中性，而中性那些是真的有盈亏发生的，
  // 拿排除过中性的胜率去乘全体均盈均亏，两个数的样本口径对不上
  const pnlN = wins.length + losses.length;
  const expectancyPct = pnlN > 0
    ? round((wins.reduce((a, b) => a + b, 0) + losses.reduce((a, b) => a + b, 0)) / pnlN, 6)
    : null;
  const expectancyPerSignalPct = expectancyPct != null && triggerRate != null
    ? round(expectancyPct * triggerRate, 6)
    : null;

  const conclusive = decided >= MIN_SAMPLE;
  return {
    settled: rows.length,
    triggerable, triggered, triggerRate,
    decided, hit, winRate, neutral,
    avgWinPct, avgLossPct, payoffRatio,
    avgMfePct: avg(mfes), avgMaePct: avg(maes),
    expectancyPct, expectancyPerSignalPct,
    conclusive, minSample: MIN_SAMPLE, target: WIN_RATE_TARGET,
    verdict: verdictText({ conclusive, decided, winRate, triggerRate, payoffRatio }),
  };
}

function pct(x: number | null): string {
  return x == null ? "—" : `${(x * 100).toFixed(1)}%`;
}

/**
 * 一句话结论。
 *
 * 样本不足时**只说样本不足**，不顺带报一个"目前 80%"——
 * 那个数一旦印在屏幕上就会被当成结论用，而它此刻只是噪声。
 */
function verdictText(s: {
  conclusive: boolean; decided: number;
  winRate: number | null; triggerRate: number | null; payoffRatio: number | null;
}): string {
  if (!s.conclusive) {
    return `样本不足：已判定 ${s.decided} 条，不到 ${MIN_SAMPLE} 条，还下不了结论`;
  }
  const parts: string[] = [];
  parts.push(
    s.winRate! >= WIN_RATE_TARGET
      ? `胜率 ${pct(s.winRate)} 达标（目标 ${pct(WIN_RATE_TARGET)}）`
      : `胜率 ${pct(s.winRate)} 未达标（目标 ${pct(WIN_RATE_TARGET)}）`
  );
  if (s.triggerRate != null && s.triggerRate < 0.3) {
    parts.push(`但触发率只有 ${pct(s.triggerRate)} —— 大部分推荐的买点够不到，胜率是纸上的`);
  }
  if (s.payoffRatio != null && s.payoffRatio < 1) {
    parts.push(`盈亏比 ${s.payoffRatio.toFixed(2)} < 1，赢的时候赚得比输的时候亏得少`);
  }
  return parts.join("；");
}
