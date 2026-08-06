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
 * 关于 trade/position：这本该是 lib/execution/manual.ts（ManualBroker）的活，
 * 那个文件还不存在，而"手工回填成交"是 manual 模式能跑起来的最低要求
 * （spec §12）。所以先落在这里。
 *   TODO(execution): ManualBroker 落地后把这两个函数改成对它的委派。
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

export interface ManualFillInput {
  accountId: string;
  code: string;
  side: "buy" | "sell";
  px: number;
  qty: number;
  ts?: string;
  fee?: number;
  stopPx?: number | null;
  thesis?: string;
  predictionId?: string | null;
}

export interface ManualFillResult {
  tradeId: string;
  /** 回填后该票的持仓，清光时为 null */
  position: { qty: number; cost: number } | null;
}

/**
 * 回填一笔已在券商成交的交易，并把持仓推到新状态。
 *
 * 买入按加权平均摊成本（含费用：费用不摊进成本的话，止损线会偏乐观）。
 * 卖出只减量不改成本 —— 剩余仓位的成本基准不该被卖出动作改写。
 * 卖超持仓直接抛错，不静默截断：数量对不上说明记错了，得让人回去核对。
 */
export function recordManualFill(db: Db, f: ManualFillInput): ManualFillResult {
  const ts = f.ts ?? shanghaiTs();
  const fee = f.fee ?? 0;
  const tradeId = crypto.randomUUID();

  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO trade (id, account_id, code, side, px, qty, ts, fee, source, prediction_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'manual', ?)`
    ).run(tradeId, f.accountId, f.code, f.side, f.px, f.qty, ts, fee, f.predictionId ?? null);

    const cur = db
      .prepare("SELECT qty, cost, open_date, stop_px, thesis FROM position WHERE account_id = ? AND code = ?")
      .get(f.accountId, f.code) as
      | { qty: number; cost: number; open_date: string; stop_px: number | null; thesis: string | null }
      | undefined;

    if (f.side === "buy") {
      const oldQty = cur?.qty ?? 0;
      const oldCost = cur?.cost ?? 0;
      const newQty = oldQty + f.qty;
      const newCost = (oldQty * oldCost + f.qty * f.px + fee) / newQty;
      db.prepare(
        `INSERT INTO position (account_id, code, cost, qty, open_date, stop_px, thesis)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(account_id, code) DO UPDATE SET
           cost = excluded.cost, qty = excluded.qty,
           stop_px = COALESCE(excluded.stop_px, position.stop_px),
           thesis = COALESCE(excluded.thesis, position.thesis)`
      ).run(
        f.accountId,
        f.code,
        newCost,
        newQty,
        cur?.open_date ?? ts.slice(0, 10),
        f.stopPx ?? cur?.stop_px ?? null,
        f.thesis ?? cur?.thesis ?? null
      );
      return { qty: newQty, cost: newCost };
    }

    if (!cur) throw new Error(`没有持仓可卖：${f.accountId} / ${f.code}`);
    if (f.qty > cur.qty + 1e-9) {
      throw new Error(`卖出数量 ${f.qty} 超过持仓 ${cur.qty}，请核对成交记录`);
    }
    const left = cur.qty - f.qty;
    if (left <= 1e-9) {
      db.prepare("DELETE FROM position WHERE account_id = ? AND code = ?").run(f.accountId, f.code);
      return null;
    }
    db.prepare("UPDATE position SET qty = ? WHERE account_id = ? AND code = ?").run(
      left,
      f.accountId,
      f.code
    );
    return { qty: left, cost: cur.cost };
  });

  const position = tx() as { qty: number; cost: number } | null;
  return { tradeId, position };
}
