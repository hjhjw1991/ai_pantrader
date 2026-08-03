import type { AdvisorInput, AdvisorMode, AdvisorSnapshot } from "@/lib/contracts/advisor";
import { cloneDefaultSlots, normalizeConfidence, type SlotRejection } from "@/lib/advisor/slots";
import { inputSnapshotHash, promptHash } from "@/lib/advisor/prompt";

/**
 * 快照构造。两条 Claude 通道（CLI / API）共用，保证降级快照长得一模一样 ——
 * 下游按 degraded 分桶做 A/B，两边字段不齐就统计不出东西。
 */

/** 模型不可用 / 响应不可解析时的快照：槽位全默认，degraded=true。绝不抛错。 */
export function degradedSnapshot(
  mode: AdvisorMode,
  input: AdvisorInput,
  model: string | null,
): AdvisorSnapshot {
  return {
    ts: input.view.asOf,
    mode,
    model,
    promptHash: promptHash(),
    inputSnapshotHash: inputSnapshotHash(input),
    slots: cloneDefaultSlots(),
    confidence: 0,
    degraded: true,
  };
}

export function filledSnapshot(
  mode: AdvisorMode,
  input: AdvisorInput,
  model: string | null,
  validated: { slots: ReturnType<typeof cloneDefaultSlots>; rejections: SlotRejection[] },
  confidence: unknown,
): AdvisorSnapshot {
  return {
    ts: input.view.asOf,
    mode,
    model,
    promptHash: promptHash(),
    inputSnapshotHash: inputSnapshotHash(input),
    slots: validated.slots,
    confidence: normalizeConfidence(confidence),
    // 注意：越界值被校验层回落 ≠ 降级。模型确实答了、只是有几条不合规，
    // 标成 degraded 会把"模型不可用"和"模型答得不规范"混成一桶，A/B 就废了。
    degraded: false,
  };
}
