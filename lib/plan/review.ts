import type { Db } from "@/lib/db";
import { review, WIN_RATE_TARGET, type ReviewStats } from "@/lib/ledger/review";
import { pushNotification } from "@/lib/ui/notify";

/**
 * 周复盘：把台账里这段时间的推荐质量汇成一条通知。
 *
 * 为什么是周频而不是日频：胜率的日间波动几乎全是噪声。
 * 一天出 3 条候选，判定 2 条，胜率不是 0% 就是 50% 或 100% ——
 * 照着这个数改参数，改的是噪声。一周约 15 条判定，趋势才开始有形状。
 * （真正的结论门槛更高，见 review.ts 的 MIN_SAMPLE = 30。）
 *
 * 只报不改：这里绝不自动调参数。参数建议走 lib/ledger/suggest，
 * 由人看过再决定 —— 一个会自己改自己的策略，回测和实盘就再也对不上了。
 */

export interface WeeklyReview {
  from: string;
  to: string;
  stats: ReviewStats;
  notified: boolean;
}

function fmtPct(x: number | null): string {
  return x == null ? "—" : `${(x * 100).toFixed(1)}%`;
}
function fmtNum(x: number | null, digits = 2): string {
  return x == null ? "—" : x.toFixed(digits);
}

/** 通知正文。三关按顺序写，让人一眼看出卡在哪一关 */
export function reviewBody(s: ReviewStats): string {
  const lines = [
    `触发率 ${fmtPct(s.triggerRate)}（${s.triggered}/${s.triggerable} 条够到买点）`,
    `胜率 ${fmtPct(s.winRate)}（${s.hit}/${s.decided} 条判定，目标 ${fmtPct(WIN_RATE_TARGET)}）`,
    `盈亏比 ${fmtNum(s.payoffRatio)}（均盈 ${fmtNum(s.avgWinPct)}% / 均亏 ${fmtNum(s.avgLossPct)}%）`,
    `区间极值 最大有利 ${fmtNum(s.avgMfePct)}% / 最大不利 ${fmtNum(s.avgMaePct)}%`,
    `每条推荐期望 ${fmtNum(s.expectancyPerSignalPct)}%（已触发的每条 ${fmtNum(s.expectancyPct)}%）`,
    s.verdict,
  ];
  return lines.join("\n");
}

export function runWeeklyReview(
  db: Db, from: string, to: string
): WeeklyReview {
  const stats = review(db, { from, to });

  /**
   * severity 按"要不要人现在去做点什么"分：
   * 样本够了且没达标 → warn（弹桌面通知，该看看参数了）；
   * 其余 → info（不弹）。样本不足是常态，为它每周弹一次，
   * 人很快就会把通知权限关掉，那会把真正的硬线告警一起弄哑。
   */
  const missed = stats.conclusive && (stats.winRate ?? 0) < WIN_RATE_TARGET;
  const notified = pushNotification(db, {
    kind: "weekly_review",
    severity: missed ? "warn" : "info",
    title: `周复盘 ${from}~${to}：${stats.settled} 条已结算`,
    body: reviewBody(stats),
    // 一周一条：job 重跑不该把同一份复盘推第二遍
    dedupeKey: `weekly_review:${to}`,
  });

  return { from, to, stats, notified };
}
