import type { ExecutionMode } from "@/lib/contracts/execution";
import { ageMinutes } from "@/lib/ui/format";
import { shanghaiTs } from "@/lib/ui/time";
import { healthVerdict, type HealthVerdict } from "@/lib/ui/derive";
import { dbExists, dbPath, readDb } from "@/lib/ui/db";
import {
  latestQuoteTs,
  sourceHealth,
  unresolvedGaps,
  type GapRow,
  type SourceHealthRow,
} from "@/lib/ui/queries";

/**
 * 全站状态条的数据。每一页都挂着它，因为这三件事任何时候都不该被折叠起来：
 *   1. 我现在看的价是几点的（陈旧快照 = 用旧价做新决策）
 *   2. 有没有不可回补的缺口（分钟线缺一天永久缺一天，spec §18.2）
 *   3. 数据源是不是在掉线（免费非官方接口，掉线是常态）
 */

/** 交易时段判定（Asia/Shanghai）。用于区分"快照该是新的"与"收盘后自然旧" */
export function shanghaiParts(now: Date): { date: string; minutes: number; weekday: number } {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
    weekday: "short",
  });
  const parts = Object.fromEntries(fmt.formatToParts(now).map((p) => [p.type, p.value]));
  const date = `${parts.year}-${parts.month}-${parts.day}`;
  // en-CA 的 hour 在 hour12:false 下可能给出 "24"（午夜），归一到 0
  const h = Number(parts.hour) % 24;
  const minutes = h * 60 + Number(parts.minute);
  const wdMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return { date, minutes, weekday: wdMap[parts.weekday ?? "Mon"] ?? 1 };
}

/** 连续竞价时段（含集合竞价 09:15 起）。用日历判交易日的活交给调用方 */
export function inSession(now: Date): boolean {
  const { minutes, weekday } = shanghaiParts(now);
  if (weekday === 0 || weekday === 6) return false;
  const am = minutes >= 9 * 60 + 15 && minutes <= 11 * 60 + 30;
  const pm = minutes >= 13 * 60 && minutes <= 15 * 60 + 5;
  return am || pm;
}

export interface HealthEntry extends SourceHealthRow {
  ageMinutes: number | null;
  verdict: HealthVerdict;
}

export interface SystemStatus {
  dbPath: string;
  dbExists: boolean;
  /** 库存在但读不开（被独占锁 / 文件损坏）时为 true */
  dbUnreadable: boolean;
  quoteTs: string | null;
  quoteAgeMinutes: number | null;
  quoteStale: boolean;
  inSession: boolean;
  gapsUnrecoverable: GapRow[];
  gapsRecoverable: GapRow[];
  health: HealthEntry[];
  worstHealth: HealthVerdict | null;
  executionMode: ExecutionMode;
  /** live 模式被挡下的原因。永远非空 —— 红线在券商权限到位前不许放开（spec §18.2） */
  liveBlockedReason: string;
}

const LIVE_BLOCKED =
  "自动下单未开放：需券商权限到位 且 paper 模式连续跑满一个季度并达标（spec §18.2 红线）";

/**
 * 执行模式。**live 永远读不出来** —— 就算环境变量写了 live 也降回 manual。
 * 这不是配置疏忽的兜底，是红线的实现：前端不存在下单能力，模式也不给它留口子。
 */
export function executionMode(env: NodeJS.ProcessEnv = process.env): ExecutionMode {
  const m = env.PANTRADER_EXECUTION_MODE;
  return m === "paper" ? "paper" : "manual";
}

export function systemStatus(now: Date = new Date()): SystemStatus {
  const p = dbPath();
  const exists = dbExists(p);
  const db = exists ? readDb(p) : null;

  const base: SystemStatus = {
    dbPath: p,
    dbExists: exists,
    dbUnreadable: exists && db === null,
    quoteTs: null,
    quoteAgeMinutes: null,
    quoteStale: false,
    inSession: inSession(now),
    gapsUnrecoverable: [],
    gapsRecoverable: [],
    health: [],
    worstHealth: null,
    executionMode: executionMode(),
    liveBlockedReason: LIVE_BLOCKED,
  };
  if (!db) return base;

  const qts = latestQuoteTs(db);
  const qAge = ageMinutes(qts, now);
  // 盘中 10 分钟不更新就是掉线（采集是分钟级）；盘后 26 小时才算陈旧（隔夜自然旧）
  const staleAfter = base.inSession ? 10 : 26 * 60;

  const gaps = unresolvedGaps(db);
  // 下界必须与库里的时间戳同口径（上海挂钟），否则字符串比较会把整段窗口筛空
  const since = shanghaiTs(new Date(now.getTime() - 24 * 3600 * 1000));
  const health: HealthEntry[] = sourceHealth(db, since).map((h) => {
    const age = ageMinutes(h.lastTs, now);
    return {
      ...h,
      ageMinutes: age,
      verdict: healthVerdict({
        lastOk: h.lastOk,
        ageMinutes: age,
        okRate: h.okRate,
        staleAfterMinutes: staleAfter,
      }),
    };
  });
  const order: HealthVerdict[] = ["ok", "failing", "stale", "down"];
  const worst = health.length
    ? health.reduce<HealthVerdict>(
        (w, h) => (order.indexOf(h.verdict) > order.indexOf(w) ? h.verdict : w),
        "ok"
      )
    : null;

  return {
    ...base,
    quoteTs: qts,
    quoteAgeMinutes: qAge,
    quoteStale: qAge !== null && qAge > staleAfter,
    gapsUnrecoverable: gaps.filter((g) => !g.recoverable),
    gapsRecoverable: gaps.filter((g) => g.recoverable),
    health,
    worstHealth: worst,
  };
}
