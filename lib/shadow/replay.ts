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
import { runShadowDay, settleShadowPending, seedVariants, type ShadowDayOpts, type ShadowDayResult } from "@/lib/shadow/book";

/**
 * 整趟回放最怕的不是某天算错，而是**跑一半崩掉**。
 *
 * 实测踩过：694 天跑到一半抛 `SqliteError: disk I/O error`（SQLITE_IOERR_READ），
 * 崩在 `runShadowDay` 的判重查询上 —— 那行在 try 之外，于是整趟直接报销。
 * 库本身没坏（重跑同一段又能过），是长事务扫描 3.7 GB 库时撞上的瞬时读错误。
 *
 * 所以这里做两件事：
 *   - 瞬时错误（IOERR / BUSY / LOCKED）等一下重跑这一天，而不是放弃整趟；
 *   - 重试几次还不行，就**记进 failed 继续往下走**，绝不中止 —— 漏掉的一天
 *     下次再跑会因为幂等判重自动补上，中止一趟的代价远大于漏一天。
 */
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

const TRANSIENT = /SQLITE_IOERR|disk I\/O error|SQLITE_BUSY|SQLITE_LOCKED|SQLITE_CANTOPEN/i;
const isTransient = (e: unknown): boolean => TRANSIENT.test((e as Error)?.message ?? "");

/** 同步睡：better-sqlite3 是同步 API，这里没有 await 可用，只能用 Atomics 让出 */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function runDayResilient(db: Db, d: string, o: ReplayOpts): ShadowDayResult {
  const opts: ShadowDayOpts = {
    decidedOn: d, baseDate: d, asOf: `${d} 15:05:00`, phase: "盘后", config: o.config, source: "replay",
    ...(o.engineFor ? { engineFor: o.engineFor } : {}),
  };
  let last: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      return runShadowDay(db, opts);
    } catch (e) {
      // 真 bug（槽位抛错、策略缺字段）必须响亮地炸，只兜瞬时故障
      if (!isTransient(e)) throw e;
      last = e;
      sleepSync(2000 * attempt);
    }
  }
  // 三次都不行：这一天记失败，继续往后跑。漏一天下次幂等补得上，不值得为它中止整趟。
  return { variants: 0, recorded: 0, skipped: [], failed: [{ variant: "*", error: `整天失败：${(last as Error)?.message ?? last}` }] };
}

export function replayShadow(db: Db, o: ReplayOpts): ReplayResult {
  seedVariants(db);
  const days = tradingDaysBetween(db, o.from, o.to);
  const res: ReplayResult = { days: days.length, recorded: 0, skippedDays: 0, failed: [], settle: { settled: 0, untriggered: 0, pending: 0 } };
  for (const d of days) {
    const r = runDayResilient(db, d, o);
    res.recorded += r.recorded;
    if (r.variants > 0 && r.skipped.length === r.variants) res.skippedDays++;
    for (const f of r.failed) res.failed.push({ date: d, ...f });
    o.onDay?.(d, r.recorded, r.failed.length);
  }
  res.settle = settleShadowPending(db, o.settleAsOf);
  return res;
}
