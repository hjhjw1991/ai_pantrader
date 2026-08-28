import type { Db } from "@/lib/db";
import { getMeta, setMeta } from "@/lib/data/meta";
import { shanghaiTs } from "@/lib/data/clock";

export interface TableCount {
  table: string;
  rows: number;
}

export interface TableCountsSnapshot {
  counts: TableCount[];
  /** 这批数字是什么时候数出来的（上海挂钟），页面必须显示，不能假装是此刻 */
  at: string;
}

/** 设置页与空态用：哪张表真的有数据。空态文案要能指出缺的是哪一张 */
export const COUNTED_TABLES = [
  "security", "trading_calendar", "kline_daily", "kline_min", "quote_snapshot",
  "zt_pool", "dt_pool", "sector_rank", "lhb", "lhb_seat", "macro",
  "data_gap", "source_health",
  "strategy", "watchpool", "prediction", "outcome", "advisor_output",
  "account", "position", "trade", "ord",
] as const;

/**
 * 真数一遍。慢，别放在请求路径上 —— 见 refreshTableCounts 的注释。
 * 导出/校验依赖它说实话，所以它永远不读缓存。
 */
export function tableCounts(db: Db): TableCount[] {
  const out: TableCount[] = [];
  for (const t of COUNTED_TABLES) {
    try {
      // 表名来自上面的常量白名单，不是用户输入
      const r = db.prepare(`SELECT COUNT(*) AS n FROM "${t}"`).get() as { n: number };
      out.push({ table: t, rows: r.n });
    } catch {
      out.push({ table: t, rows: -1 }); // -1 = 表不存在（migration 未跑）
    }
  }
  return out;
}

/** app_meta 里存快照的键 */
export const TABLE_COUNTS_KEY = "table_counts";

/**
 * 数一遍并把结果写进 app_meta，供页面直接读。
 *
 * 为什么必须由后台进程来数：COUNT(*) 在 SQLite 里没有 O(1) 写法。
 * 实测本机 2.0 GB 库、22 张表一轮 4.1–5.4 秒（kline_daily 5.75M 行 1.87s、
 * quote_snapshot 7.13M 行 0.69s），而且这个代价**每次都要重付** ——
 * 库比可用内存大，两次统计之间操作系统的页缓存已经被挤掉了。
 *
 * 更要命的是 better-sqlite3 是同步的：这 4 秒钉死整个 Node 事件循环。
 * 以前这段跑在 web 进程里、带 60 秒缓存，于是每分钟就有一个倒霉的请求
 * 卡满四秒，期间 SSE、其它页签、正在跑的回测流一起停摆。
 * 实测：连续访问 /lab，时间在 4.1s 和 0.02s 之间按分钟交替。
 *
 * 行数是**体检指标**，不是行情。它慢慢变没关系，卡住界面才有关系。
 * 所以搬到夜间 job：那里阻塞 4 秒没有任何人在等。
 */
export function refreshTableCounts(db: Db, now: Date = new Date()): TableCountsSnapshot {
  const snap: TableCountsSnapshot = { counts: tableCounts(db), at: shanghaiTs(now) };
  setMeta(db, TABLE_COUNTS_KEY, JSON.stringify(snap));
  return snap;
}

/**
 * 读回快照。坏 JSON / 缺字段一律当作"没有快照"返回 null，
 * 让调用方走它自己的兜底路径 —— 半个快照比没有快照更难排查。
 */
export function readTableCountsSnapshot(db: Db): TableCountsSnapshot | null {
  const raw = getMeta(db, TABLE_COUNTS_KEY);
  if (raw === null) return null;
  try {
    const p = JSON.parse(raw) as unknown;
    if (p === null || typeof p !== "object") return null;
    const { counts, at } = p as { counts?: unknown; at?: unknown };
    if (typeof at !== "string" || !Array.isArray(counts)) return null;
    const ok = counts.every(
      (c) => c !== null && typeof c === "object"
        && typeof (c as TableCount).table === "string"
        && typeof (c as TableCount).rows === "number"
    );
    return ok ? { counts: counts as TableCount[], at } : null;
  } catch {
    return null;
  }
}
