import { createHash } from "node:crypto";
import type { AdvisorInput } from "@/lib/contracts/advisor";
import { GEARS, MAX_EXTRA_SECTORS, MAX_NARRATIVE_LEN, MAX_RISK_LEN, SCORE_ADJUST_MAX, SCORE_ADJUST_MIN } from "@/lib/advisor/slots";

/**
 * 提示词与哈希。CLI 与 API 两条通道共用这里，保证同一份输入在两条通道下
 * promptHash / inputSnapshotHash 算法一致 —— 否则 A/B 的两组样本没法对齐。
 *
 * promptHash 只覆盖"静态实验条件"（模板 + schema + 版本号），不含输入；
 * inputSnapshotHash 只覆盖输入。两者分开是 spec §5.2 的要求：
 * 同一 prompt 配不同输入会导致回放对不上，所以必须能分别追溯。
 */

/** 改提示词就把它 +1：换了提示词就是换了实验条件，历史样本不能混算 */
export const PROMPT_VERSION = "advisor-slots-v1";

/**
 * 槽位的线格式 schema。两处刻意的取舍：
 *   1. map 类槽位（scoreAdjust/risks）用数组表达 —— 严格 JSON Schema 不支持任意键对象
 *      （additionalProperties 只能是 false）。
 *   2. 可空字段用 anyOf 而不是 type:["string","null"] —— 后者不在结构化输出的
 *      受支持子集里，写了会被整个 schema 拒掉。
 */
export const SLOT_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["slots", "confidence"],
  properties: {
    slots: {
      type: "object",
      additionalProperties: false,
      required: ["gearOverride", "scoreAdjust", "extraSectors", "risks", "narrative"],
      properties: {
        gearOverride: { anyOf: [{ type: "string", enum: [...GEARS] }, { type: "null" }] },
        scoreAdjust: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["code", "delta"],
            properties: { code: { type: "string" }, delta: { type: "number" } },
          },
        },
        extraSectors: { type: "array", items: { type: "string" } },
        risks: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["code", "risk"],
            properties: { code: { type: "string" }, risk: { type: "string" } },
          },
        },
        narrative: { anyOf: [{ type: "string" }, { type: "null" }] },
      },
    },
    confidence: { type: "number" },
  },
} as const;

const TEMPLATE = `你是 A 股量化系统 PanTrader 的辅助顾问。系统已经用规则引擎算出了环境档位与候选池，
你的唯一职责是在下面这几个预定义槽位里给出修正建议。

硬约束：
- 只能填槽，不能改写信号本身，也不能新增槽位。输出多余字段会被丢弃。
- gearOverride 只能是 ${GEARS.join(" / ")} 或 null（null = 不修正）。
- scoreAdjust 的 delta 必须在 ${SCORE_ADJUST_MIN}~${SCORE_ADJUST_MAX} 之间，code 必须出自下面的候选池。
- risks 每条不超过 ${MAX_RISK_LEN} 字，会原样展示给用户。
- extraSectors 最多 ${MAX_EXTRA_SECTORS} 条，用于补你认为被漏扫的主线。
- narrative 不超过 ${MAX_NARRATIVE_LEN} 字，纯展示，不进决策。
- 没把握就留默认值（null / 空数组）。留空不算失败，乱填会污染回测。
- confidence 是你对本次建议整体的置信度，0~1。

判断重点（方法论）：硬催化 vs 纯情绪、洗盘 vs 派发、板块均值是否掩盖了链内龙头。
只输出一个 JSON 对象，不要任何解释文字或代码块围栏。`;

export function buildPrompt(input: AdvisorInput): string {
  const payload = {
    asOf: input.view.asOf,
    env: {
      gear: input.env.gear,
      targetPosition: input.env.targetPosition,
      reasons: input.env.reasons,
      lowConfidenceFactors: input.env.lowConfidenceFactors,
    },
    candidates: input.candidates.map(c => ({
      code: c.code,
      name: c.name,
      action: c.action,
      account: c.account,
      score: c.score,
      triggerPx: c.triggerPx,
      stopPx: c.stopPx,
      thesis: c.thesis,
      passedFilters: c.passedFilters,
      rejectedBy: c.rejectedBy ?? [],
    })),
  };
  return `${TEMPLATE}\n\n当前时点与信号：\n${JSON.stringify(payload, null, 2)}\n`;
}

const sha = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 16);

/** 静态实验条件的指纹。不含输入 —— 同一版提示词跑不同交易日必须同 hash。 */
export function promptHash(): string {
  return sha(`${PROMPT_VERSION}\n${TEMPLATE}\n${JSON.stringify(SLOT_JSON_SCHEMA)}`);
}

/**
 * NullAdvisor 的 promptHash。它压根没发提示词，但快照仍需要一个稳定且可辨识的值，
 * 否则 A/B 分组时无法把"无 Claude 的对照组"从数据里挑出来。
 */
export const NULL_PROMPT_HASH = sha(`${PROMPT_VERSION}\nnull-advisor`);

/**
 * 输入快照哈希。只取会影响建议的字段，且候选按 code 排序 ——
 * 候选池顺序抖动不该被当成"换了输入"，否则回放永远对不上。
 */
export function inputSnapshotHash(input: AdvisorInput): string {
  const canonical = {
    asOf: input.view.asOf,
    gear: input.env.gear,
    targetPosition: input.env.targetPosition,
    reasons: input.env.reasons,
    candidates: [...input.candidates]
      .map(c => ({ code: c.code, action: c.action, account: c.account, score: c.score }))
      .sort((a, b) => a.code.localeCompare(b.code)),
  };
  return sha(JSON.stringify(canonical));
}
