/**
 * v2 引擎入口。
 *
 * v1 仍在 lib/strategy/engine.ts，原封不动 —— 它是影子盘里的 baseline 对照组。
 * 两者并存是有期限的：v2 的 baseline 组合在实盘样本上稳定打平或打赢 v1 之后，
 * v1 的函数体搬进 slots/baseline.ts，engine.ts 退役。
 */
export { createV2Engine, type V2Deps, type V2Input } from "@/lib/strategy/v2/engine";
export { createSlotRegistry } from "@/lib/strategy/v2/registry";
export { BASELINE_SLOTS, BASELINE_CHOICE } from "@/lib/strategy/v2/slots/baseline";
export { 评估器_可配权重打分, 默认权重 } from "@/lib/strategy/v2/slots/weighted-score";

import { createSlotRegistry } from "@/lib/strategy/v2/registry";
import { BASELINE_SLOTS } from "@/lib/strategy/v2/slots/baseline";
import { 评估器_可配权重打分 } from "@/lib/strategy/v2/slots/weighted-score";

/**
 * 默认槽位注册表：模块加载时构建一次。
 * 要往里加槽的调用方应当自己 createSlotRegistry()，别往共享实例上挂 ——
 * 否则回测与实盘会看到不同的槽集合，而这正是"结果无法归因"的经典起点。
 */
export const defaultSlotRegistry = createSlotRegistry([...BASELINE_SLOTS, 评估器_可配权重打分]);
