import type { Advisor, AdvisorInput, AdvisorSnapshot } from "@/lib/contracts/advisor";
import { cloneDefaultSlots } from "@/lib/advisor/slots";
import { NULL_PROMPT_HASH, inputSnapshotHash } from "@/lib/advisor/prompt";

/**
 * NullAdvisor —— 没有 Claude 时的缺省实现（D2）。
 *
 * degraded=false 是刻意的：宿主没装 Claude 是一种正常配置，不是故障。
 * 如果这里标 degraded，健康面板会天天报警，而且 A/B 时无法区分
 * "本来就没 Claude"和"有 Claude 但这次调用挂了"这两件完全不同的事。
 *
 * 调用方拿到的和 ClaudeAdvisor 是同一种 AdvisorSnapshot，所以主流程
 * 一个 if 都不用写 —— 这就是"同一条代码路径喂不同实现"的落点。
 */
export class NullAdvisor implements Advisor {
  readonly mode = "null" as const;

  async advise(input: AdvisorInput): Promise<AdvisorSnapshot> {
    return {
      // ts 取 view.asOf 而非 Date.now()：回测按 ts 回放当时槽位（spec §5.2），
      // 用真实时间会让回测时间轴和实盘时间轴错开，回放直接对不上。
      ts: input.view.asOf,
      mode: "null",
      model: null,
      promptHash: NULL_PROMPT_HASH,
      inputSnapshotHash: inputSnapshotHash(input),
      // 必须是副本：DEFAULT_SLOTS 是共享常量，返回它本体会被调用方就地改写污染全局
      slots: cloneDefaultSlots(),
      confidence: 0,
      degraded: false,
    };
  }
}

export function createNullAdvisor(): Advisor {
  return new NullAdvisor();
}
