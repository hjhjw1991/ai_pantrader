/**
 * 影子盘的第一批变体。
 *
 * 选这几套，是因为它们各自回答一个具体的问题，而不是"多跑几套总有一套好"：
 *
 *   baseline         对照组。v2 的 baseline 槽组合，与 v1 逐字段一致（parity 保证）
 *   结构位定价        只换评估器：按盈亏比取舍、排序，值不值？
 *   五段状态机        只换择时器：按情绪阶段定档位，比"今天盘面强不强"好不好？
 *   五段+结构位       两个一起换：效果是叠加还是互相抵消？
 *   五段高潮进攻+结构位 样本内检验里高潮日次日溢价显著偏高（t = 2.1），
 *                    与"高潮不追"的默认映射相反 —— 让真实候选来裁决
 *
 * 一次只换一个槽的变体是刻意的：两个槽一起换，赢了也分不清是谁的功劳。
 * id 一经写进台账就不能改（样本按它归因）；要改组合就新开一个 id。
 */
import type { SlotConfig } from "@/lib/contracts";

export interface VariantDef {
  id: string;
  name: string;
  slots: Partial<SlotConfig>;
  note: string;
}

export const BASELINE_VARIANT = "baseline";

export const DEFAULT_VARIANTS: VariantDef[] = [
  { id: BASELINE_VARIANT, name: "baseline", slots: {}, note: "对照组：v2 baseline 槽组合，与 v1 逐字段一致" },
  { id: "pricing", name: "结构位定价", slots: { 评估器: { 用: "结构位定价" } },
    note: "只换评估器：目标价取前高 / ATR 兜底，盈亏比 < 1.5 不进候选，按盈亏比排序" },
  { id: "cycle", name: "五段状态机", slots: { 择时器: { 用: "五段状态机" } },
    note: "只换择时器：冰点中性、启动发酵进攻、高潮中性、退潮防守" },
  { id: "cycle+pricing", name: "五段+结构位", slots: { 择时器: { 用: "五段状态机" }, 评估器: { 用: "结构位定价" } },
    note: "两个一起换" },
  { id: "cycle-hot+pricing", name: "五段高潮进攻+结构位",
    slots: { 择时器: { 用: "五段状态机", 参数: { 阶段档位: { 高潮: "进攻" } } }, 评估器: { 用: "结构位定价" } },
    note: "高潮也进攻：样本内高潮日次日涨停溢价显著偏高（+0.49pp，t = 2.1）" },
];
