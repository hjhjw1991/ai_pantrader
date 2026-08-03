import { DEFAULT_SLOTS, type AdvisorSlots } from "@/lib/contracts/advisor";
import type { EnvGear } from "@/lib/contracts/strategy";

/**
 * 槽位校验层。
 *
 * 为什么 Claude 只能填这几个格子、且每个格子都要校验：
 *   1. 自由改写信号对象 = 回测无法回放（同一份历史输入跑两次结果不一致），
 *      也就没法做 with/without A/B —— spec §5.2/§5.3 的前提直接没了。
 *   2. 模型偶发输出越界值（scoreAdjust=99、档位写成"梭哈"）。
 *      这类值一旦进决策，仓位/评分会被单条噪声带跑，所以宁可回落该槽默认值，
 *      也不把垃圾往下游传。丢弃动作全部记进 rejections，复盘时能看见模型犯了什么错。
 */

export const GEARS: EnvGear[] = ["进攻", "中性", "防守"];

/** 加减分区间，来自契约注释"建议范围 -1~1"，这里当硬约束用 */
export const SCORE_ADJUST_MIN = -1;
export const SCORE_ADJUST_MAX = 1;
/** 上限存在的理由：模型跑飞时会灌一长串板块名，别让它淹掉主线判断 */
export const MAX_EXTRA_SECTORS = 10;
/** 风险提示原样进信号卡，长文本会把卡面撑爆 */
export const MAX_RISK_LEN = 200;
export const MAX_NARRATIVE_LEN = 300;

export interface SlotRejection {
  slot: keyof AdvisorSlots;
  /** 个股级槽位（scoreAdjust/risks）被拒的那只票 */
  key?: string;
  received: unknown;
  reason: string;
}

export interface SlotValidation {
  slots: AdvisorSlots;
  rejections: SlotRejection[];
}

export interface ValidateOpts {
  /**
   * 候选池代码白名单。给了就强校验：模型对着不在池里的票加减分是幻觉，
   * 静默接受会造出一条无法归因的"看不见的持仓建议"。
   */
  knownCodes?: string[];
}

export function cloneDefaultSlots(): AdvisorSlots {
  return {
    gearOverride: DEFAULT_SLOTS.gearOverride,
    scoreAdjust: {},
    extraSectors: [],
    risks: {},
    narrative: DEFAULT_SLOTS.narrative,
  };
}

export function isDefaultSlots(s: AdvisorSlots): boolean {
  return (
    s.gearOverride === null &&
    Object.keys(s.scoreAdjust ?? {}).length === 0 &&
    (s.extraSectors ?? []).length === 0 &&
    Object.keys(s.risks ?? {}).length === 0 &&
    (s.narrative === null || s.narrative === undefined)
  );
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * map 槽位的两种线格式都收：
 *   { "600123": 0.3 }                     —— 人写 YAML / 手工构造最自然
 *   [{ code: "600123", delta: 0.3 }]      —— 严格 JSON Schema 表达不了任意键 map，
 *                                            走 CLI --json-schema / API structured
 *                                            output 时只能用数组
 * 两边都兼容，省掉一个"模型格式选错就整槽失效"的坑。
 */
function toEntries(raw: unknown, valueKeys: string[]): Array<[string, unknown]> | null {
  if (isObj(raw)) return Object.entries(raw);
  if (Array.isArray(raw)) {
    const out: Array<[string, unknown]> = [];
    for (const item of raw) {
      if (!isObj(item)) continue;
      const code = item.code ?? item.symbol;
      if (typeof code !== "string") continue;
      const key = valueKeys.find(k => k in item);
      out.push([code, key === undefined ? undefined : item[key]]);
    }
    return out;
  }
  return null;
}

export function validateSlots(raw: unknown, opts: ValidateOpts = {}): SlotValidation {
  const slots = cloneDefaultSlots();
  const rejections: SlotRejection[] = [];
  const known = opts.knownCodes ? new Set(opts.knownCodes) : null;
  const reject = (slot: keyof AdvisorSlots, received: unknown, reason: string, key?: string) =>
    rejections.push({ slot, key, received, reason });

  // 输入本身不是对象（模型返回了裸字符串/数组/null）—— 整体回落默认值
  if (!isObj(raw)) {
    if (raw !== undefined && raw !== null) {
      reject("narrative", raw, "槽位载荷不是对象");
    }
    return { slots, rejections };
  }

  // --- gearOverride：枚举外一律回落 null（= 不修正） ---
  if (raw.gearOverride !== undefined && raw.gearOverride !== null) {
    if (typeof raw.gearOverride === "string" && (GEARS as string[]).includes(raw.gearOverride)) {
      slots.gearOverride = raw.gearOverride as EnvGear;
    } else {
      reject("gearOverride", raw.gearOverride, `不是合法档位（${GEARS.join("/")}）`);
    }
  }

  // --- scoreAdjust：逐条校验，坏条目单独丢，好条目保留 ---
  if (raw.scoreAdjust !== undefined && raw.scoreAdjust !== null) {
    const entries = toEntries(raw.scoreAdjust, ["delta", "adjust", "value", "score"]);
    if (entries === null) {
      reject("scoreAdjust", raw.scoreAdjust, "既不是 map 也不是 [{code,delta}] 数组");
    } else {
      for (const [code, v] of entries) {
        if (!code.trim()) {
          reject("scoreAdjust", v, "代码为空", code);
        } else if (known && !known.has(code)) {
          reject("scoreAdjust", v, "代码不在候选池里", code);
        } else if (typeof v !== "number" || !Number.isFinite(v)) {
          reject("scoreAdjust", v, "不是有限数字", code);
        } else if (v < SCORE_ADJUST_MIN || v > SCORE_ADJUST_MAX) {
          reject("scoreAdjust", v, `超出 ${SCORE_ADJUST_MIN}~${SCORE_ADJUST_MAX}`, code);
        } else {
          slots.scoreAdjust[code] = v;
        }
      }
    }
  }

  // --- extraSectors：trim + 去重 + 限量 ---
  if (raw.extraSectors !== undefined && raw.extraSectors !== null) {
    if (!Array.isArray(raw.extraSectors)) {
      reject("extraSectors", raw.extraSectors, "不是数组");
    } else {
      for (const s of raw.extraSectors) {
        if (typeof s !== "string" || !s.trim()) {
          reject("extraSectors", s, "不是非空字符串");
          continue;
        }
        const name = s.trim();
        if (slots.extraSectors.includes(name)) continue;
        if (slots.extraSectors.length >= MAX_EXTRA_SECTORS) {
          reject("extraSectors", name, `超出上限 ${MAX_EXTRA_SECTORS} 条`);
          continue;
        }
        slots.extraSectors.push(name);
      }
    }
  }

  // --- risks：逐条校验，长度超限直接丢（不截断，截断会切出半句误导人） ---
  if (raw.risks !== undefined && raw.risks !== null) {
    const entries = toEntries(raw.risks, ["risk", "text", "note", "value", "reason"]);
    if (entries === null) {
      reject("risks", raw.risks, "既不是 map 也不是 [{code,risk}] 数组");
    } else {
      for (const [code, v] of entries) {
        if (known && !known.has(code)) {
          reject("risks", v, "代码不在候选池里", code);
        } else if (typeof v !== "string" || !v.trim()) {
          reject("risks", v, "不是非空字符串", code);
        } else if (v.length > MAX_RISK_LEN) {
          reject("risks", v, `超出 ${MAX_RISK_LEN} 字`, code);
        } else {
          slots.risks[code] = v.trim();
        }
      }
    }
  }

  // --- narrative：纯展示，坏值回落 null ---
  if (raw.narrative !== undefined && raw.narrative !== null) {
    if (typeof raw.narrative !== "string" || !raw.narrative.trim()) {
      reject("narrative", raw.narrative, "不是非空字符串");
    } else if (raw.narrative.length > MAX_NARRATIVE_LEN) {
      reject("narrative", raw.narrative, `超出 ${MAX_NARRATIVE_LEN} 字`);
    } else {
      slots.narrative = raw.narrative.trim();
    }
  }

  return { slots, rejections };
}

/** 置信度也可能是垃圾：非数字或越界一律按 0 处理，别让它加权出负仓位 */
export function normalizeConfidence(v: unknown): number {
  if (typeof v !== "number" || !Number.isFinite(v)) return 0;
  return Math.min(1, Math.max(0, v));
}
