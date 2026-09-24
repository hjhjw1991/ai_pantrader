import crypto from "node:crypto";
import type Database from "better-sqlite3";
import type { Broker, Fill, Order, Position } from "@/lib/contracts/execution";
import { shanghaiTs } from "@/lib/data/clock";

/**
 * manual 模式的执行层（spec §12）：**系统出单，人在券商 App 手敲，回来回填成交。**
 *
 * 这是 Broker 契约的唯一真实实现。paper / live 以后按同一个契约接进来，策略层零感知：
 *   submit            → 开一张"下单单"（ord.status = pending），不向任何券商发请求
 *   confirmManualFill → 人回填成交：写 trade、推 position、把单子标成 filled / partial
 *   cancel            → 人决定不下了：pending / partial 的单子标 cancelled
 *
 * 红线（§18.2）：本文件没有、也不许有任何网络调用。
 */

type Db = Database.Database;

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
  /** 关联的下单单（ord.id）。不经下单单直接回填时不给 */
  orderId?: string | null;
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
export function recordFill(db: Db, f: ManualFillInput): ManualFillResult {
  const ts = f.ts ?? shanghaiTs();
  const fee = f.fee ?? 0;
  const tradeId = crypto.randomUUID();

  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO trade (id, account_id, code, side, px, qty, ts, fee, source, prediction_id, order_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'manual', ?, ?)`
    ).run(tradeId, f.accountId, f.code, f.side, f.px, f.qty, ts, fee, f.predictionId ?? null, f.orderId ?? null);

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


const EPS = 1e-9;

function toOrder(r: any): Order {
  return {
    id: r.id, ts: r.ts, account: r.account_id, code: r.code, side: r.side, px: r.px, qty: r.qty, status: r.status,
    ...(r.prediction_id ? { predictionId: r.prediction_id } : {}),
  };
}

export class ManualBroker implements Broker {
  readonly mode = "manual" as const;
  constructor(private readonly db: Db) {}

  /** 开一张下单单。价格与数量先校验：A 股一手 100 股，限价必须为正 */
  async submit(o: Omit<Order, "id" | "status" | "ts">): Promise<Order> {
    if (!(o.px > 0)) throw new Error(`限价必须为正：${o.px}`);
    if (!(o.qty > 0) || o.qty % 100 !== 0) throw new Error(`数量必须是 100 股的正整数倍：${o.qty}`);
    const acct = this.db.prepare("SELECT 1 FROM account WHERE id = ?").get(o.account);
    if (acct === undefined) throw new Error(`账户不存在：${o.account}`);
    const id = crypto.randomUUID();
    this.db.prepare(
      `INSERT INTO ord (id, ts, account_id, code, side, px, qty, status, prediction_id) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)`
    ).run(id, shanghaiTs(), o.account, o.code, o.side, o.px, o.qty, o.predictionId ?? null);
    return this.order(id)!;
  }

  async cancel(orderId: string): Promise<void> {
    const r = this.db.prepare("UPDATE ord SET status = 'cancelled' WHERE id = ? AND status IN ('pending', 'partial')").run(orderId);
    if (r.changes === 0) throw new Error(`下单单 ${orderId} 不存在或已成交 / 已撤`);
  }

  /**
   * 回填这张单子的一笔成交。同一张单可以分几次回填（券商分笔成交），
   * 累计够量标 filled，不够标 partial；超量直接拒绝 —— 数量对不上说明记错了。
   */
  async confirmManualFill(orderId: string, f: Omit<Fill, "orderId" | "source">): Promise<void> {
    const o = this.order(orderId);
    if (o === null) throw new Error(`下单单 ${orderId} 不存在`);
    if (o.status !== "pending" && o.status !== "partial") throw new Error(`下单单 ${orderId} 是 ${o.status}，不能再回填`);
    const done = (this.db.prepare("SELECT COALESCE(SUM(qty), 0) AS q FROM trade WHERE order_id = ?").get(orderId) as { q: number }).q;
    if (done + f.qty > o.qty + EPS) throw new Error(`回填数量 ${f.qty} 超过剩余 ${o.qty - done}`);
    this.db.transaction(() => {
      recordFill(this.db, {
        accountId: o.account, code: o.code, side: o.side, px: f.px, qty: f.qty, ts: f.ts, fee: f.fee,
        predictionId: o.predictionId ?? null, orderId,
      });
      this.db.prepare("UPDATE ord SET status = ? WHERE id = ?").run(done + f.qty >= o.qty - EPS ? "filled" : "partial", orderId);
    })();
  }

  async positions(): Promise<Position[]> {
    return (this.db.prepare("SELECT account_id, code, qty, cost, open_date, stop_px, thesis FROM position ORDER BY account_id, code").all() as any[])
      .map(r => ({ account: r.account_id, code: r.code, qty: r.qty, cost: r.cost, openDate: r.open_date, stopPx: r.stop_px, thesis: r.thesis ?? "" }));
  }

  /** 成交。没挂在下单单上的（直接回填的）用成交自己的 id 当 orderId */
  async fills(from: string, to: string): Promise<Fill[]> {
    return (this.db.prepare(
      "SELECT id, order_id, ts, px, qty, fee, source FROM trade WHERE ts >= ? AND ts <= ? ORDER BY ts, id"
    ).all(from, to) as any[]).map(r => ({ orderId: r.order_id ?? r.id, ts: r.ts, px: r.px, qty: r.qty, fee: r.fee, source: r.source }));
  }

  /** 还没成交完的下单单（给界面列"待手敲"） */
  openOrders(): Order[] {
    return (this.db.prepare("SELECT * FROM ord WHERE status IN ('pending', 'partial') ORDER BY ts").all() as any[]).map(toOrder);
  }

  private order(id: string): Order | null {
    const r = this.db.prepare("SELECT * FROM ord WHERE id = ?").get(id);
    return r === undefined ? null : toOrder(r);
  }
}
