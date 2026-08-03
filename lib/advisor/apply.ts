import type { AdvisorSlots } from "@/lib/contracts/advisor";
import type { Candidate, EnvAssessment, EnvGear } from "@/lib/contracts/strategy";
import { validateSlots, type SlotRejection } from "@/lib/advisor/slots";

/**
 * 把校验过的槽位落到 EnvAssessment + Candidate[] 上，并交出一份逐条改动清单。
 *
 * 为什么必须留改动清单：下游要把 prediction.advisor_influenced 标准确，
 * 才能在 spec §5.3 做 with/without A/B。只知道"顾问跑过"没用，
 * 得知道它到底改了哪个槽、哪只票、从什么改成什么 —— 事后归因和复盘都靠这个。
 *
 * 另一条纪律：不就地改调用方传进来的对象。回测要能拿同一份输入重放多次，
 * 上游对象被偷偷改过就再也复现不了了。
 */

export interface SlotChange {
  slot: keyof AdvisorSlots;
  /** 个股级改动的标的；环境级为 null */
  code: string | null;
  /** 被改的字段名，如 gear / targetPosition / score / warnings */
  field: string;
  before: unknown;
  after: unknown;
}

export interface ApplyOptions {
  /** 档位→目标仓位映射，来自 strategy.yaml 的 择时.仓位档位。不给就只改档位不改仓位 */
  gearPositions?: Record<EnvGear, number>;
  /**
   * 是否允许模型把档位往激进方向抬。默认 false。
   *
   * 理由：红线写着"防守档 = 0 仓，不是轻仓"，而用户目标是牛市长期稳定盈利、不追高。
   * 让模型把 防守→进攻 是单次调用就能造成最大伤害的一步，风险与收益完全不对称：
   * 降档判错只是少赚，升档判错是真亏。要开就显式开，别让默认值替人担这个风险。
   */
  allowRiskUp?: boolean;
}

export interface ApplyResult {
  env: EnvAssessment;
  candidates: Candidate[];
  /** 逐条改动，供归因与 A/B */
  changes: SlotChange[];
  /** 被拒的槽位值（越界、未知代码、被风控挡下的升档） */
  rejections: SlotRejection[];
  /** 风险提示，调用方并进 SignalCard.warnings（Candidate 上没有风险字段，见报告） */
  warnings: string[];
  /** 模型认为被漏扫的板块：这里不重扫，交给上层策略层决定 */
  extraSectors: string[];
  /** 一句话叙事，只展示不进决策 */
  narrative: string | null;
  /** 有任何改动就为 true —— 直接喂 prediction.advisorInfluenced */
  influenced: boolean;
}

/** 档位激进度排序，用来判断一次 override 是升档还是降档 */
export const GEAR_RISK_ORDER: Record<EnvGear, number> = { 防守: 0, 中性: 1, 进攻: 2 };

function cloneEnv(env: EnvAssessment): EnvAssessment {
  return { ...env, reasons: [...env.reasons], lowConfidenceFactors: [...env.lowConfidenceFactors] };
}

export function applySlots(
  env: EnvAssessment,
  candidates: Candidate[],
  slots: AdvisorSlots,
  opts: ApplyOptions = {},
): ApplyResult {
  const nextEnv = cloneEnv(env);
  const nextCandidates = candidates.map(c => ({ ...c }));
  const changes: SlotChange[] = [];
  const warnings: string[] = [];

  // 再校验一次：这里能拿到候选池，可以顺手抓出"模型对着不存在的票加减分"。
  // 重复校验的成本可以忽略，漏掉一条幻觉建议的成本不行。
  const { slots: safe, rejections } = validateSlots(slots, {
    knownCodes: candidates.map(c => c.code),
  });

  // --- gearOverride ---
  if (safe.gearOverride !== null && safe.gearOverride !== nextEnv.gear) {
    const isRiskUp = GEAR_RISK_ORDER[safe.gearOverride] > GEAR_RISK_ORDER[nextEnv.gear];
    if (isRiskUp && !opts.allowRiskUp) {
      rejections.push({
        slot: "gearOverride",
        received: safe.gearOverride,
        reason: `不允许把档位从 ${nextEnv.gear} 抬到 ${safe.gearOverride}（需显式 allowRiskUp）`,
      });
    } else {
      changes.push({ slot: "gearOverride", code: null, field: "gear", before: nextEnv.gear, after: safe.gearOverride });
      nextEnv.gear = safe.gearOverride;

      if (opts.gearPositions) {
        const after = opts.gearPositions[safe.gearOverride];
        if (typeof after === "number" && after !== nextEnv.targetPosition) {
          changes.push({
            slot: "gearOverride",
            code: null,
            field: "targetPosition",
            before: nextEnv.targetPosition,
            after,
          });
          nextEnv.targetPosition = after;
        }
      }

      // 归因是给人看的：档位被谁改的必须写在卡上，否则第二天没人说得清为什么空仓
      const reason = `Advisor 建议档位调整为 ${safe.gearOverride}`;
      changes.push({
        slot: "gearOverride",
        code: null,
        field: "reasons",
        before: [...env.reasons],
        after: [...nextEnv.reasons, reason],
      });
      nextEnv.reasons.push(reason);
    }
  }

  // --- scoreAdjust ---
  for (const [code, delta] of Object.entries(safe.scoreAdjust)) {
    const target = nextCandidates.find(c => c.code === code);
    if (!target) continue; // 校验层已经把未知代码记进 rejections
    if (delta === 0) continue;
    const before = target.score;
    const after = before + delta;
    target.score = after;
    changes.push({ slot: "scoreAdjust", code, field: "score", before, after });
  }

  // --- risks ---
  // Candidate 上没有风险字段（契约缺口，见最终报告），所以走 warnings 交给信号卡。
  // 它算 influenced：风险提示会出现在用户看的卡面上，可能直接改变执行动作。
  for (const [code, risk] of Object.entries(safe.risks)) {
    const text = `风险提示 ${code}：${risk}`;
    warnings.push(text);
    changes.push({ slot: "risks", code, field: "warnings", before: null, after: text });
  }

  return {
    env: nextEnv,
    candidates: nextCandidates,
    changes,
    rejections,
    warnings,
    // extraSectors 与 narrative 都不构成本次改动：
    //   - extraSectors 要靠策略层重扫才有意义，这里改不了 env/candidates
    //   - narrative 契约写明"只作展示，不进决策"
    // 把它们算进 influenced 会给 A/B 造出一批"其实什么都没改"的实验组样本。
    extraSectors: [...safe.extraSectors],
    narrative: safe.narrative,
    influenced: changes.length > 0,
  };
}
