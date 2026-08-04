import type { PointInTimeView } from "@/lib/contracts/pit";
import type { Candidate, EnvAssessment } from "@/lib/contracts/strategy";

/**
 * Advisor 契约（D2/D3）。
 *
 * 硬约束：有 Claude 时它是增强，没 Claude 时系统功能完整 —— 不是两套代码路径，
 * 是同一条路径喂不同的实现。NullAdvisor 返回全默认槽位，调用方不做任何 if。
 *
 * 允许 Claude 改信号，但每次填槽都要留结构化快照，否则回测不可复现（spec §5.2）。
 */

export type AdvisorMode = "null" | "claude-cli" | "claude-api";

/**
 * 槽位是预定义的、带默认值的。Claude 只能填这些槽，不能自由改写信号对象 ——
 * 自由改写等于回测无法回放，也无法做 with/without A/B。
 */
export interface AdvisorSlots {
  /** 对环境档位的修正建议。null = 不修正 */
  gearOverride: EnvAssessment["gear"] | null;
  /** 候选票的加减分，code -> delta（建议范围 -1~1） */
  scoreAdjust: Record<string, number>;
  /** 主线判断补充：模型认为被漏扫的板块 */
  extraSectors: string[];
  /** 对某只票的风险提示，会原样进信号卡 */
  risks: Record<string, string>;
  /** 一句话行情叙事，只作展示，不进决策 */
  narrative: string | null;
}

export const DEFAULT_SLOTS: AdvisorSlots = {
  gearOverride: null,
  scoreAdjust: {},
  extraSectors: [],
  risks: {},
  narrative: null,
};

export interface AdvisorInput {
  view: PointInTimeView;
  env: EnvAssessment;
  candidates: Candidate[];
}

export interface AdvisorSnapshot {
  ts: string;
  /**
   * 一次 Advisor 调用的标识，A/B 对照的分组键（spec §5.3）。
   *
   * 必须存在的理由：A/B 是"同一份输入跑两次"，两次的 ts 天然相同，
   * 只靠 ts 做行身份会让第二次覆盖第一次，对照组永远为空。
   *
   * 省略时由 (mode, promptHash, inputSnapshotHash) 确定性派生 ——
   * 不掺时钟和随机数，否则同一份历史输入回放两次会得到不同 run_id，
   * 违反 spec §17 断言 4 的可复现性。
   */
  runId?: string;
  mode: AdvisorMode;
  model: string | null;
  /** 提示词哈希 + 输入快照哈希：换了提示词就是换了实验条件，必须能分辨 */
  promptHash: string;
  inputSnapshotHash: string;
  slots: AdvisorSlots;
  confidence: number;
  /** 模型不可用时为 true，槽位为默认值。这不是错误，是降级 */
  degraded: boolean;
}

export interface Advisor {
  readonly mode: AdvisorMode;
  /** 永不抛错：模型挂了就返回 degraded 快照 + 默认槽位，主流程不受影响 */
  advise(input: AdvisorInput): Promise<AdvisorSnapshot>;
}
