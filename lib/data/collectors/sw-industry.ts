import type { Db } from "@/lib/db";
import type { SourceClient } from "@/lib/data/client";
import {
  SW_LEVEL1, SW_LEVEL3_EXPECTED, fetchComponents, fetchIndexNames, level3Codes,
  type SwIndex,
} from "@/lib/data/sources/swsresearch";
import { recordGap, resolveGap, today } from "@/lib/data/gap";

/**
 * 快照周期。7 天是在两件事之间取的平衡：
 * 差分推出来的退出日期最多滞后一个周期（越短越准），
 * 而每次是 377 次串行请求、约 4 分钟（越短越费源）。
 * 行业归属变动本身很慢（并购、主业变更才会动），周频足够。
 */
export const SW_SNAPSHOT_MAX_AGE_DAYS = 7;

export interface SwSnapshotResult {
  snapshotDate: string;
  /** 各层写入的成分行数 */
  level1: number;
  level3: number;
  failed: Array<{ indexCode: string; error: string }>;
}

export interface CollectSwOpts {
  snapshotDate?: string;
  /** 每个行业之间的间隔。实测并发 ≥3 就开始被 WAF 拦，所以只能串行 + 轻微节流 */
  pauseMs?: number;
}

/**
 * 申万行业快照采集。
 *
 * 三条硬约束，全部来自 2026-09-22 实测：
 *
 * 1. **必须串行**。并发 ≥3 就开始被 WAF 拦（8 并发 13% 拦截率，
 *    而 3 并发反而 21% —— 并发数比 QPS 更敏感）。串行 508 次请求约 4 分钟。
 * 2. **被拦的行业不写任何行**。阻断页是 HTTP 200 + HTML，解析出来是 0 条成分；
 *    要是把它当"这个行业今天没有成分股"写进去，下游看到的是一个真的空行业，
 *    而不是一次失败。所以拦到就整个行业跳过 + 记缺口，宁可这张快照缺一个行业。
 * 3. **三级行业数变了要报警**。346 是 2021 版三级行业数；变了意味着申万调整了
 *    分类体系，历史归因会断代，这是需要人看一眼的事件，不该默默跟随。
 *
 * 失败记 recoverable 缺口：快照是周频的，今天拦了明天重来完全来得及。
 */
export async function collectSwIndustry(
  db: Db, client: SourceClient, o: CollectSwOpts = {}
): Promise<SwSnapshotResult> {
  const snapshotDate = o.snapshotDate ?? today();
  const pauseMs = o.pauseMs ?? 0;

  const stmt = db.prepare(
    `INSERT OR REPLACE INTO sw_industry_snapshot
       (snapshot_date, code, level, index_code, index_name, weight, beginning_date)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );

  const failed: SwSnapshotResult["failed"] = [];
  const counts = { 1: 0, 3: 0 } as Record<1 | 3, number>;

  let l3: SwIndex[] = [];
  try {
    l3 = level3Codes(await fetchIndexNames(client));
    resolveGap(db, snapshotDate, client.source, "sw_industry:index_name");
  } catch (e: any) {
    // 名单拿不到就没法采三级。一级仍然照采——半张快照也比没有强，
    // 但必须留下痕迹，否则差分时会把"那次没采到"误判成"这些票退出了行业"。
    recordGap(db, snapshotDate, client.source, "sw_industry:index_name", e.message, true);
    failed.push({ indexCode: "index_name", error: e.message });
  }

  if (l3.length > 0 && l3.length !== SW_LEVEL3_EXPECTED) {
    recordGap(
      db, snapshotDate, client.source, "sw_industry:level3_count",
      `三级行业数 ${l3.length} ≠ 期望 ${SW_LEVEL3_EXPECTED}：申万可能调整了分类体系，历史归因会断代，请人工确认`,
      false
    );
  }

  const jobs: Array<{ idx: SwIndex; level: 1 | 3 }> = [
    ...SW_LEVEL1.map(idx => ({ idx, level: 1 as const })),
    ...l3.map(idx => ({ idx, level: 3 as const })),
  ];

  for (const { idx, level } of jobs) {
    try {
      const rows = await fetchComponents(client, idx.code);
      // 整个行业一次事务写入：拿到了才写，拿不到一行都不写
      db.transaction(() => {
        for (const r of rows) {
          stmt.run(snapshotDate, r.code, level, idx.code, idx.name, r.weight, r.beginningDate);
        }
      })();
      counts[level] += rows.length;
      /**
       * 采到了就把这个行业当天的缺口销掉。
       *
       * 不销的后果在这个仓库里是有案底的（见 collectors/daily.ts 那段注释）：
       * 回测的 hasGap(date) 不带 kind 调用，那天只要还挂着任何一条未解决缺口，
       * **整个交易日对全市场直接跳过**。一次行业快照的临时失败，
       * 会让那一天此后在所有回测里永久消失。
       *
       * 只销同一天的：一次成功的快照说明的是"今天的归属"，它并不能追认
       * 上一周那次失败 —— 那一周的行业状态是真的永久不知道了，缺口该留着。
       */
      resolveGap(db, snapshotDate, client.source, `sw_industry:${idx.code}`);
    } catch (e: any) {
      const msg = e?.message ?? String(e);
      recordGap(db, snapshotDate, client.source, `sw_industry:${idx.code}`, msg, true);
      failed.push({ indexCode: idx.code, error: msg });
    }
    if (pauseMs > 0) await new Promise(r => setTimeout(r, pauseMs));
  }

  return { snapshotDate, level1: counts[1], level3: counts[3], failed };
}

/** 最近一张快照的日期；一张都没有返回 null */
export function lastSwSnapshotDate(db: Db): string | null {
  const r = db.prepare(
    "SELECT MAX(snapshot_date) AS d FROM sw_industry_snapshot"
  ).get() as { d: string | null } | undefined;
  return r?.d ?? null;
}

/**
 * 最近一张**完整**快照的日期：一级与三级都采到了才算数。
 *
 * 为什么要区分完整与否 —— 这是实测踩出来的（2026-09-22 第一次真跑）：
 * 三级行业名单那一个请求 fetch failed，于是只落了一级的 5218 行。
 * 若按"有没有快照行"判断，库里已经有今天的行，下一次 night 就认为今天采过了，
 * 7 天内不再重试 —— 三级空着一整周，而这一周的行业变更**永久推不出来**
 * （今天去采只能采到今天的归属）。半张快照堵死重试，比没采还糟。
 */
export function lastCompleteSwSnapshotDate(db: Db): string | null {
  const r = db.prepare(
    `SELECT snapshot_date AS d FROM sw_industry_snapshot
      GROUP BY snapshot_date
     HAVING SUM(level = 1) > 0 AND SUM(level = 3) > 0
      ORDER BY snapshot_date DESC LIMIT 1`
  ).get() as { d: string | null } | undefined;
  return r?.d ?? null;
}

/**
 * 该不该采下一张快照。
 *
 * 判据是**最近一张完整快照**的年龄，不是"有没有行"。
 *
 * 空表、半张快照、日期解析不出来（脏数据）一律当"该采"：宁可多采一次，
 * 也不要因为一个解析不了的时间戳或一次半途失败让快照序列停在那里 ——
 * 这条序列一旦断档，断掉的那段行业变更就永久推不出来了。
 */
export function swSnapshotDue(db: Db, now: Date, maxAgeDays = SW_SNAPSHOT_MAX_AGE_DAYS): boolean {
  const last = lastCompleteSwSnapshotDate(db);
  if (last === null) return true;
  const lastMs = Date.parse(`${last.slice(0, 10)}T00:00:00Z`);
  if (!Number.isFinite(lastMs)) return true;
  return (now.getTime() - lastMs) / 86_400_000 >= maxAgeDays;
}
