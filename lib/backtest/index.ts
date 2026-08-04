/**
 * 回测层对外入口（M3）。上层（app/api/backtest、寻优面板）只从这里 import，
 * 别去 import 内部文件 —— 内部结构以后要改。
 *
 * 依赖方向：本层只依赖 lib/contracts 的类型。PointInTimeView 与 StrategyEngine
 * 都是**注入**进来的（runBacktest 的 viewFactory / strategy），
 * 回测层不认识 lib/pit 与 lib/strategy 的实现。
 */
export * from "@/lib/backtest/types";
export * from "@/lib/backtest/constraints";
export * from "@/lib/backtest/metrics";
export * from "@/lib/backtest/coverage";
export * from "@/lib/backtest/replay";
export * from "@/lib/backtest/walkforward";
export * from "@/lib/backtest/optimizer";
export * from "@/lib/backtest/proxy-audit";
export * from "@/lib/backtest/hash";
