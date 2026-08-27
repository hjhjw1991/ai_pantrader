import type { Db } from "@/lib/db";
import { shanghaiTs } from "@/lib/data/clock";
import { readStrategyConfig } from "@/lib/ui/adapters/strategy";
import { todaySignalCard } from "@/lib/ui/adapters/engines";
import { pushNotification } from "@/lib/ui/notify";

/**
 * 盘前作战计划：09:15 跑一次策略引擎，把当天的候选推到通知里。
 *
 * 为什么 09:15 这个时点有意义 —— 而不是"随时打开页面看一眼就行"：
 *
 * 候选池的重活（全市场 5,888 只的筛选打分）读的是**日线与截面**，而当天的日线要等
 * 22:00 的 night job 才落库。也就是说盘中任何时刻算出来的候选，用的都是截至昨收的
 * 那份数据 —— 今天的实时快照只在最后一步用于算"现价距触发价还差多少"。
 * 既然选股结论在开盘前就已经确定，它就该在开盘前交到人手上，
 * 而不是等人想起来去开页面。09:15 是集合竞价开始的时刻，正好是看这张单子的时候。
 *
 * **不写台账**。prediction 表是胜率闭环的输入，往里写等于宣告"策略做了这些预测、
 * 请按它们统计胜率"。那是另一个决定，不该由一个"盘前提个醒"的 job 顺手打开。
 *
 * 分层：本模块在 lib/data 之上（它要用 strategy/factors/config）。
 * lib/data 从不反向依赖 lib/ui，所以 job 那边只留一个可选钩子，
 * 由组装根（scripts/daemon.ts、scripts/job.ts）把这个实现注进去。
 */

export interface PreopenPlan {
  ok: boolean;
  reason?: string;
  gear?: string;
  candidates: Array<{ code: string; name?: string; triggerPx: number | null; thesis?: string }>;
  /** 引擎自己报的警告条数，写进通知正文的提示里 */
  warnings: number;
  notified: boolean;
}

export async function runPreopenPlan(db: Db): Promise<PreopenPlan> {
  const cfg = readStrategyConfig();
  if (!cfg.available) {
    // 配置不可用要**响**：盘前没算出计划，人不该到开盘才发现
    pushNotification(db, {
      kind: "preopen_plan", severity: "warn",
      title: "盘前计划未生成", body: `策略配置不可用：${cfg.reason}`,
    });
    return { ok: false, reason: cfg.reason, candidates: [], warnings: 0, notified: true };
  }

  const out = todaySignalCard(db, shanghaiTs(), cfg.config);
  if (!out.available) {
    pushNotification(db, {
      kind: "preopen_plan", severity: "warn",
      title: "盘前计划未生成", body: out.reason,
    });
    return { ok: false, reason: out.reason, candidates: [], warnings: 0, notified: true };
  }

  const card = out.card;
  const candidates = card.candidates.map(c => ({
    code: c.code,
    name: (c as { name?: string }).name,
    triggerPx: (c as { triggerPx?: number | null }).triggerPx ?? null,
    thesis: (c as { thesis?: string }).thesis,
  }));
  const warnings = card.warnings?.length ?? 0;
  const gear = card.env?.gear;

  /**
   * severity 按"有没有要人做的动作"分，不按"消息重不重要"分：
   * 有候选 → warn（会弹桌面通知，人要在开盘前看一眼触发价）；
   * 没有候选 → info（不弹）。防守档 0 仓、或全被过滤器否决，都是正常且正确的结果，
   * 为它弹一次通知，几天之后人就会把通知权限关掉，那等于把真正的硬线告警一起弄哑。
   */
  const body = candidates.length === 0
    ? `档位 ${gear ?? "?"}，无买入候选`
      + (warnings > 0 ? `；引擎有 ${warnings} 条警告，见作战台` : "")
    : candidates
        .map(c => `${c.code}${c.name ? " " + c.name : ""}`
          + (c.triggerPx === null ? "（未给触发价）" : ` 触发 ${c.triggerPx}`))
        .join("；")
      + (warnings > 0 ? `｜引擎有 ${warnings} 条警告，见作战台` : "");

  const notified = pushNotification(db, {
    kind: "preopen_plan",
    severity: candidates.length > 0 ? "warn" : "info",
    title: `盘前计划：${gear ?? "?"}档 · ${candidates.length} 只候选`,
    body,
    // 一天只推一次：job 重跑（唤醒补偿、手动触发）不该把同一份计划推第二遍
    dedupeKey: `preopen_plan:${shanghaiTs().slice(0, 10)}`,
  });

  return { ok: true, gear, candidates, warnings, notified };
}
