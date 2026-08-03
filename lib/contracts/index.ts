/**
 * 冻结的跨层契约。M1–M5 各层都只依赖这里的类型，不互相依赖实现。
 *
 * 依赖方向单向：data → factor → strategy → signal → execution，Advisor 侧挂。
 * 改这里的类型会同时影响多个层，动之前先看清谁在用。
 */
export * from "@/lib/contracts/pit";
export * from "@/lib/contracts/factor";
export * from "@/lib/contracts/strategy";
export * from "@/lib/contracts/advisor";
export * from "@/lib/contracts/execution";
export * from "@/lib/contracts/backtest";
export * from "@/lib/contracts/ledger";
