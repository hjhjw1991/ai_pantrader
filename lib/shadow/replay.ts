/**
 * 影子盘冷启动：把各变体在历史上逐日回放一遍，攒出回放样本。
 *
 * 回放样本**只用于排座次**，不计入毕业（用户 2026-09-23 选定）。原因：
 *   - 回放没有盘中快照，而实盘候选的换手 / 振幅筛读的是当时的快照
 *   - 回放不给行业映射（映射只有当前一份，回刷历史就是前视），于是「量价」候选源在回放里是关着的
 *   - 回放是在我们已经知道结局的那段行情上调出来的参数上跑的
 * 它能回答的是"哪套明显不行、哪套值得盯"，不能回答"哪套可以上实盘"。
 *
 * 可中断：runShadowDay 本身幂等（按 变体 + 来源 + 基准日 判重），
 * 跑到一半停掉再跑，已完成的日子直接跳过。
 */
import type { Db } from "@/lib/db";
import type { StrategyConfig } from "@/lib/contracts";
import { tradingDaysBetween } from "@/lib/data/calendar";
import { runShadowDay, settleShadowPending, seedVariants, type ShadowDayOpts } from "@/lib/shadow/book";

export interface ReplayOpts {
  from: string;
  to: string;
  config: StrategyConfig;
  /** 结算用的"今天"：回放完顺手把能结的都结了 */
  settleAsOf: string;
  onDay?: (date: string, recorded: number, failed: number) => void;
  engineFor?: ShadowDayOpts["engineFor"];
}

export interface ReplayResult {
  days: number;
  recorded: number;
  skippedDays: number;
  failed: Array<{ date: string; variant: string; error: string }>;
  settle: { settled: number; untriggered: number; pending: number };
}

export function replayShadow(db: Db, o: ReplayOpts): ReplayResult {
  seedVariants(db);
  const days = tradingDaysBetween(db, o.from, o.to);
  const res: ReplayResult = { days: days.length, recorded: 0, skippedDays: 0, failed: [], settle: { settled: 0, untriggered: 0, pending: 0 } };
  for (const d of days) {
    const r = runShadowDay(db, {
      decidedOn: d, baseDate: d, asOf: `${d} 15:05:00`, phase: "盘后", config: o.config, source: "replay",
      ...(o.engineFor ? { engineFor: o.engineFor } : {}),
    });
    res.recorded += r.recorded;
    if (r.skipped.length === r.variants) res.skippedDays++;
    for (const f of r.failed) res.failed.push({ date: d, ...f });
    o.onDay?.(d, r.recorded, r.failed.length);
  }
  res.settle = settleShadowPending(db, o.settleAsOf);
  return res;
}
