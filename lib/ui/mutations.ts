import crypto from "node:crypto";
import type Database from "better-sqlite3";
import type { AccountType } from "@/lib/contracts/strategy";
import { shanghaiTs } from "@/lib/ui/time";

/**
 * 前端唯一的写路径。只写**人输入的东西**，不写行情。
 *
 * 三张表：watchpool（我盯哪些票）、trade（我在券商 App 里实际成交了什么）、
 * position（由成交推出来的持仓）、account（我有哪几个账户）。
 * 行情/截面/龙虎榜一律由 launchd job 写，前端连 INSERT 都不写。
 *
 * trade/position 的写入在 lib/execution/manual.ts（ManualBroker），这里的 recordManualFill 只是委派。
 *
 * 没有任何一个函数会向券商发单。整个前端不存在下单能力（红线 §18.2）。
 */

type Db = Database.Database;

export interface WatchpoolInput {
  code: string;
  name?: string;
  account: AccountType;
  triggerPx?: number | null;
  stopPx?: number | null;
  thesis?: string;
}

export function upsertWatch(db: Db, w: WatchpoolInput): void {
  db.prepare(
    `INSERT INTO watchpool (code, name, account, trigger_px, stop_px, thesis, added_at, active)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1)
     ON CONFLICT(code) DO UPDATE SET
       name = excluded.name, account = excluded.account,
       trigger_px = excluded.trigger_px, stop_px = excluded.stop_px,
       thesis = excluded.thesis, active = 1`
  ).run(
    w.code,
    w.name ?? null,
    w.account,
    w.triggerPx ?? null,
    w.stopPx ?? null,
    w.thesis ?? null,
    // 全库时间戳口径是上海挂钟（migration 006）：写 toISOString 会让这一行
    // 在 `WHERE ts <= ?` 的字符串比较里永远排到最后（'T' > ' '）
    shanghaiTs()
  );
}

/** 移出观察池用软删：active=0。历史上盯过什么是复盘素材，不该物理删掉 */
export function deactivateWatch(db: Db, code: string): void {
  db.prepare("UPDATE watchpool SET active = 0 WHERE code = ?").run(code);
}

export interface AccountInput {
  id: string;
  name: string;
  type: AccountType;
}

export function upsertAccount(db: Db, a: AccountInput): void {
  db.prepare(
    `INSERT INTO account (id, name, type, active, created_at)
     VALUES (?, ?, ?, 1, ?)
     ON CONFLICT(id) DO UPDATE SET name = excluded.name, type = excluded.type,
       -- 重新保存一个停用过的账户 = 恢复它。要真删就走 deleteAccount
       active = 1`
  ).run(a.id, a.name, a.type, shanghaiTs());
}

export function setAccountActive(db: Db, id: string, active: boolean): boolean {
  const r = db.prepare("UPDATE account SET active = ? WHERE id = ?").run(active ? 1 : 0, id);
  return r.changes > 0;
}

/** 这个账户被台账引用了多少次。>0 就不能物理删 */
export function accountRefs(db: Db, id: string): { positions: number; trades: number; orders: number } {
  const one = (sql: string) => (db.prepare(sql).get(id) as { c: number }).c;
  return {
    positions: one("SELECT COUNT(*) c FROM position WHERE account_id = ?"),
    trades: one("SELECT COUNT(*) c FROM trade WHERE account_id = ?"),
    orders: one("SELECT COUNT(*) c FROM ord WHERE account_id = ?"),
  };
}

export interface DeleteAccountResult {
  id: string;
  mode: "hard" | "soft";
  refs: { positions: number; trades: number; orders: number };
  note: string;
}

/**
 * 删账户。**有引用就只停用，不物理删。**
 *
 * 硬删一个还挂着 position/trade 的账户，台账里那些行的 account_id 就指向不存在的账户：
 * 持仓页显示不出归属、按账户分组的胜率统计凭空少一组，而且没有任何提示 ——
 * 这正是"静默丢历史"。所以规则按引用分两种：
 *   有引用 → active=0。界面不再列它、引擎不给它出候选，但历史归属完整保留
 *   无引用 → 物理删。建错了名字随手就能清掉，不该留一堆停用的空壳
 */
export function deleteAccount(db: Db, id: string): DeleteAccountResult {
  const refs = accountRefs(db, id);
  const total = refs.positions + refs.trades + refs.orders;
  if (total > 0) {
    setAccountActive(db, id, false);
    return {
      id, mode: "soft", refs,
      note: `台账里有 ${refs.positions} 条持仓 / ${refs.trades} 条成交 / ${refs.orders} 条委托`
        + `挂在 ${id} 上，已停用而非删除 —— 硬删会让这些历史记录失去归属`,
    };
  }
  db.prepare("DELETE FROM account WHERE id = ?").run(id);
  return { id, mode: "hard", refs, note: `${id} 没有任何台账引用，已彻底删除` };
}

export function accountExists(db: Db, id: string): boolean {
  const r = db.prepare("SELECT 1 AS x FROM account WHERE id = ?").get(id);
  return r !== undefined;
}

export type { ManualFillInput, ManualFillResult } from "@/lib/execution/manual";
import { recordFill, type ManualFillInput, type ManualFillResult } from "@/lib/execution/manual";

/** 回填一笔已在券商成交的交易。实现在 ManualBroker 那边（lib/execution/manual.ts），这里只是前端的入口 */
export function recordManualFill(db: Db, f: ManualFillInput): ManualFillResult {
  return recordFill(db, f);
}

// ═══════════════════════════ 回测存档 ═══════════════════════════

export interface SaveReportInput {
  kind: "backtest" | "sweep";
  strategyId: string;
  strategyVersion: string;
  from: string;
  to: string;
  initialCash: number;
  metrics: { annualReturn: number; maxDrawdown: number; calmar: number; trades: number } | null;
  /** 扫描独有：扫了几个点 */
  evaluated?: number;
  report: unknown;
}

/**
 * 只留最近这么多份。
 *
 * 定 50 而不是不限：报告是不可变快照，历史价值随时间快速衰减
 * （半年前那次用的是半年前的数据和参数），而无限增长的表迟早要有人手工清。
 * 一年跨度实测 13 KB，四年约 50 KB，50 份约 2.6 MB —— 对一个 2 GB 的库可以忽略。
 */
export const REPORT_KEEP = 50;

/**
 * 存一份报告，并把超出保留数的旧档删掉。
 *
 * id 用"生成时刻 + 随机后缀"而不是内容哈希：同一份配置同一段区间重跑一次，
 * 用户想看到的是两条记录（"我又跑了一次"），而不是被去重成一条 ——
 * 报告里带着 generatedAt，两次本来就不是同一份东西。
 */
export function saveBacktestReport(db: Db, i: SaveReportInput): string {
  const ts = shanghaiTs();
  const id = `${ts.replace(/[^0-9]/g, "")}-${Math.floor(Math.random() * 1e6).toString(36)}`;
  db.prepare(
    `INSERT INTO backtest_report
       (id, ts, kind, strategy_id, strategy_ver, from_date, to_date, initial_cash,
        annual_return, max_drawdown, calmar, trades, evaluated, report_json)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    id, ts, i.kind, i.strategyId, i.strategyVersion, i.from, i.to, i.initialCash,
    i.metrics?.annualReturn ?? null, i.metrics?.maxDrawdown ?? null,
    i.metrics?.calmar ?? null, i.metrics?.trades ?? null,
    i.evaluated ?? null, JSON.stringify(i.report)
  );

  // 超额的按时间从旧到新删。用子查询选出要保留的，而不是先数再算偏移 ——
  // 后者在并发写入时会多删或少删
  db.prepare(
    `DELETE FROM backtest_report WHERE id NOT IN (
       SELECT id FROM backtest_report ORDER BY ts DESC LIMIT ?
     )`
  ).run(REPORT_KEEP);

  return id;
}

/** 删一份存档。用户主动删才调，保留数超了走 saveBacktestReport 里的自动清理 */
export function deleteBacktestReport(db: Db, id: string): void {
  db.prepare("DELETE FROM backtest_report WHERE id = ?").run(id);
}
