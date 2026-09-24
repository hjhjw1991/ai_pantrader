import type Database from "better-sqlite3";
import type { Broker, ExecutionMode } from "@/lib/contracts/execution";
import { ManualBroker } from "@/lib/execution/manual";

export { ManualBroker, recordFill } from "@/lib/execution/manual";

/**
 * 执行层入口：按 execution.mode 取一个 Broker。策略层只认 Broker 契约，不知道背后是谁。
 *
 * 只有 manual 是真的。paper / live 留着缝：
 *   - paper 还没实现（要一个按实时快照撮合的模拟账户），调用直接抛错
 *   - live 的红线（spec §18.2）：券商权限到位、且 paper 连续跑满一个季度达标之前，只能是 stub
 * 两者都不许"先降级成 manual 凑合用"：调用方以为自己在自动下单，实际什么都没发生，比报错危险。
 */
export function createBroker(db: Database.Database, mode: ExecutionMode): Broker {
  if (mode === "manual") return new ManualBroker(db);
  if (mode === "paper") throw new Error("paper 模式尚未实现：需要按实时快照撮合的模拟账户");
  return liveStub;
}

const refuse = (): never => {
  throw new Error("live 模式未开放：需要券商权限到位，且 paper 模式连续跑满一个季度达标（spec §18.2）");
};

/** live 占位：任何调用都拒绝 */
const liveStub: Broker = {
  mode: "live",
  submit: async () => refuse(),
  cancel: async () => refuse(),
  positions: async () => refuse(),
  fills: async () => refuse(),
};
