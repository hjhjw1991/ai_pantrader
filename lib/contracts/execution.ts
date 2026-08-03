import type { AccountType } from "@/lib/contracts/strategy";

/**
 * 执行层（spec §12）。execution.mode 切换，策略层零感知。
 *
 * 红线：live 模式必须同时满足 —— 券商权限到位，且 paper 连续跑满一个季度并达标。
 * LiveBroker 在此之前只允许存在为 stub，submit 必须直接抛错。
 */

export type ExecutionMode = "manual" | "paper" | "live";
export type Side = "buy" | "sell";
export type OrderStatus = "pending" | "submitted" | "filled" | "partial" | "cancelled" | "rejected";

export interface Order {
  id: string;
  ts: string;
  account: AccountType;
  code: string;
  side: Side;
  /** 限价。A股没有真正的市价单语义，一律带价 */
  px: number;
  qty: number;
  status: OrderStatus;
  /** 关联的预测，用于事后对账归因 */
  predictionId?: string;
}

export interface Fill {
  orderId: string;
  ts: string;
  px: number;
  qty: number;
  fee: number;
  source: ExecutionMode;
}

export interface Position {
  account: AccountType;
  code: string;
  qty: number;
  cost: number;
  openDate: string;
  stopPx: number | null;
  thesis: string;
}

export interface Broker {
  readonly mode: ExecutionMode;
  submit(o: Omit<Order, "id" | "status" | "ts">): Promise<Order>;
  cancel(orderId: string): Promise<void>;
  positions(): Promise<Position[]>;
  fills(from: string, to: string): Promise<Fill[]>;
  /**
   * manual 模式专用：人在券商 App 手敲后回填成交。
   * paper/live 不该被调用，实现里直接抛错，别静默接受伪造成交。
   */
  confirmManualFill?(orderId: string, f: Omit<Fill, "orderId" | "source">): Promise<void>;
}
