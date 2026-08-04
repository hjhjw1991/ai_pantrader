/**
 * StrategyConfig 的取值校验（spec §9.2 三重校验之一：参数在合法区间）。
 *
 * 两条设计约束：
 *   1. **报错必须带行号 + 键名**。策略包要在机器之间搬，导入失败时用户手上只有
 *      一个字符串和几十行 YAML；"validation failed" 等于让他逐行猜。
 *   2. **未知键不丢**。YAML 是唯一真相源（D7），校验器无权把用户写的段落吞掉，
 *      所以用 looseObject 而不是默认的 strip。
 */
import { z } from "zod";
import { load, YAMLException } from "js-yaml";
import type { StrategyConfig } from "@/lib/contracts/strategy";
import { indexYaml, locate, type YamlIndex } from "@/lib/strategy/yaml-pos";

/** 相对项目根。参数面板与导入导出都引用这个常量，别各写一份字符串 */
export const DEFAULT_STRATEGY_YAML_REL = "config/strategy.yaml";

/**
 * 账户键归一化。**不维护账户名白名单** —— 账户由用户定义，代码不该知道它们叫什么。
 *
 * 只做一件事：去掉结尾的"账户"二字，让 `贼王` 与 `贼王账户` 指向同一个账户。
 * 这个别名需求是真实的：spec §9.1 的 YAML 写"贼王账户"，而 ledger 契约的
 * paramPath 示例写"持仓.贼王.止损"，一份照 spec 抄下来的 YAML 必须读得出规则。
 * 但它是**构词规则**，跟具体账户名无关，所以对用户新建的任何账户同样成立。
 */
export const ACCOUNT_KEY_SUFFIX = "账户";

export function normalizeAccountKey(k: string): string {
  const t = k.trim();
  return t.length > ACCOUNT_KEY_SUFFIX.length && t.endsWith(ACCOUNT_KEY_SUFFIX)
    ? t.slice(0, -ACCOUNT_KEY_SUFFIX.length)
    : t;
}

/* --------------------------------- zod --------------------------------- */

const 比例 = z.number().finite().min(0).max(1);
/** 上限类参数：0 仓位上限意味着策略永远不开仓，那是关掉系统而不是配置策略 */
const 正比例 = z.number().finite().gt(0).max(1);

const SEMVER = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

/** 防守触发的值：数字（阈值）或布尔（开关）。字符串没法判定，单独在 crossChecks 里挡 */
const 触发值 = z.union([z.number().finite(), z.boolean(), z.string()]);

/** 账户规则的值形态很杂：止损可以是 -0.05 也可以是"逻辑破坏"，止盈是 ["0.08减半","0.15清"] */
const 账户规则值 = z.union([
  z.number().finite(), z.boolean(), z.string(),
  z.array(z.union([z.number().finite(), z.string()])),
]);

export const StrategyConfigSchema = z.looseObject({
  id: z.string().min(1),
  version: z.string().regex(SEMVER, "必须是语义化版本，形如 1.0.0"),

  择时: z.looseObject({
    仓位档位: z.looseObject({ 进攻: 比例, 中性: 比例, 防守: 比例 }),
    防守触发: z.record(z.string(), 触发值),
  }),

  选股: z.looseObject({
    过滤器阈值: z.record(z.string(), z.number().finite().min(0)),
    主线识别: z.looseObject({
      板块涨幅榜TopN: z.number().int().min(1).max(50),
      // 不许为空：spec §8.2 明写必查链是叠加项、不可关闭。
      // 允许空数组等于给了一个"合法地关掉主线兜底"的开关，那正是 2026-07-27 漏扫的成因。
      必查链: z.array(z.string().min(1)).min(1, "必查链不可为空（spec §8.2 写死，只能叠加不能清空）"),
    }),
  }),

  持仓: z.record(z.string(), z.record(z.string(), 账户规则值)),

  组合风控: z.looseObject({
    总仓位上限: 正比例,
    单票最大占比: 正比例,
    单行业最大占比: 正比例,
    核心卫星比例: z.looseObject({ 核心: 比例, 卫星: 比例 }),
  }),

  因子参数: z.record(z.string(), z.record(z.string(), z.unknown())).optional(),
});

/* ------------------------------- 结果类型 ------------------------------- */

export interface ValidationIssue {
  path: string[];
  message: string;
  /** 1 起。没有源文本（直接校验对象）或定位不到时为 null */
  line: number | null;
  column: number | null;
}

export type ValidateOk = { ok: true; config: StrategyConfig; issues: ValidationIssue[] };
export type ValidateFail = { ok: false; issues: ValidationIssue[]; message: string };
export type ValidateResult = ValidateOk | ValidateFail;

export function formatIssue(i: ValidationIssue): string {
  const where = i.line === null ? "" : `第 ${i.line} 行 `;
  const key = i.path.length === 0 ? "(根)" : i.path.join(".");
  return `${where}${key}：${i.message}`;
}

export function formatIssues(issues: ValidationIssue[]): string {
  return issues.map(formatIssue).join("\n");
}

/* ------------------------------- 跨字段规则 ------------------------------- */

type Raw = Record<string, unknown>;

const asObj = (v: unknown): Raw =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? v as Raw : {};

const asNum = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

/**
 * zod 表达不了、但错了会直接亏钱的规则。
 * 单独写成函数而不是塞进 refine，是为了能自己控制 path —— path 决定行号指到哪一行。
 */
function crossChecks(cfg: Raw): Array<{ path: string[]; message: string }> {
  const out: Array<{ path: string[]; message: string }> = [];

  const 择时 = asObj(cfg["择时"]);
  const 档位 = asObj(择时["仓位档位"]);
  const 防守 = asNum(档位["防守"]);
  const 进攻 = asNum(档位["进攻"]);
  const 中性 = asNum(档位["中性"]);

  // 防守 = 0 仓，不是"轻仓"。留一成过冬是最常见的自我安慰：
  // 只要还有仓位，就还会盯、还会补、还会扛，纪律等于没有。
  if (防守 !== null && 防守 !== 0) {
    out.push({
      path: ["择时", "仓位档位", "防守"],
      message: `防守档必须为 0（当前 ${防守}）—— 防守 = 空仓，"轻仓过冬"不是防守`,
    });
  }
  if (进攻 !== null && 中性 !== null && 进攻 < 中性) {
    out.push({
      path: ["择时", "仓位档位", "进攻"],
      message: `进攻档仓位 ${进攻} 低于中性档 ${中性}，档位顺序颠倒`,
    });
  }

  // 防守触发：字符串值无法判定真假。留着它等于配置里有一条永远不生效的条件。
  for (const [k, v] of Object.entries(asObj(择时["防守触发"]))) {
    if (typeof v === "string") {
      out.push({
        path: ["择时", "防守触发", k],
        message: `条件值只能是数字（阈值）或布尔（开关），拿到字符串 ${JSON.stringify(v)}`,
      });
      continue;
    }
    if (/[><]$/.test(k) && typeof v !== "number") {
      out.push({
        path: ["择时", "防守触发", k],
        message: `键名以 ${k.slice(-1)} 结尾表示与阈值比较，值必须是数字`,
      });
    }
  }

  const 风控 = asObj(cfg["组合风控"]);
  const 总上限 = asNum(风控["总仓位上限"]);
  const 单票 = asNum(风控["单票最大占比"]);
  const 单行业 = asNum(风控["单行业最大占比"]);
  if (总上限 !== null && 单票 !== null && 单票 > 总上限) {
    out.push({
      path: ["组合风控", "单票最大占比"],
      message: `单票上限 ${单票} 超过总仓位上限 ${总上限}，两条上限自相矛盾`,
    });
  }
  if (总上限 !== null && 单行业 !== null && 单行业 > 总上限) {
    out.push({
      path: ["组合风控", "单行业最大占比"],
      message: `单行业上限 ${单行业} 超过总仓位上限 ${总上限}，两条上限自相矛盾`,
    });
  }
  const 核卫 = asObj(风控["核心卫星比例"]);
  const 核心 = asNum(核卫["核心"]);
  const 卫星 = asNum(核卫["卫星"]);
  if (核心 !== null && 卫星 !== null && Math.abs(核心 + 卫星 - 1) > 1e-9) {
    out.push({
      path: ["组合风控", "核心卫星比例"],
      message: `核心 ${核心} + 卫星 ${卫星} = ${核心 + 卫星}，必须等于 1`,
    });
  }

  // 持仓段的账户键
  const 持仓 = asObj(cfg["持仓"]);
  const keys = Object.keys(持仓);
  // 不校验账户叫什么名字 —— 那是用户的决定。只挡空键这种真正无法处理的输入
  for (const k of keys) {
    if (normalizeAccountKey(k).length === 0) {
      out.push({ path: ["持仓", k], message: `账户键不能为空` });
    }
  }
  // 同一账户写了两种别名 → 两份规则，实际生效哪份取决于遍历顺序
  const seen = new Map<string, string>();
  for (const k of keys) {
    const norm = normalizeAccountKey(k);
    if (norm.length === 0) continue;
    const prev = seen.get(norm);
    if (prev !== undefined) {
      out.push({ path: ["持仓", k], message: `与 ${prev} 指向同一账户 ${norm}，重复配置` });
    } else {
      seen.set(norm, k);
    }
  }

  return out;
}

/* --------------------------------- 入口 --------------------------------- */

function issuesFrom(parsed: z.ZodSafeParseResult<unknown>, cfg: Raw): Array<{ path: string[]; message: string }> {
  const out: Array<{ path: string[]; message: string }> = [];
  if (!parsed.success) {
    for (const i of parsed.error.issues) {
      out.push({ path: i.path.map(String), message: i.message });
    }
  }
  // 结构不过时跨字段检查照跑：一次把所有问题都报出来，别让用户改一条跑一次
  out.push(...crossChecks(cfg));
  return out;
}

/** 直接校验一个已解析的对象。没有源文本，所以行号一律 null。 */
export function validateStrategyConfig(input: unknown): ValidateResult {
  const cfg = asObj(input);
  const parsed = StrategyConfigSchema.safeParse(input);
  const raw = issuesFrom(parsed, cfg);
  if (raw.length === 0) {
    return { ok: true, config: parsed.data as unknown as StrategyConfig, issues: [] };
  }
  const issues = raw.map(r => ({ ...r, line: null, column: null }));
  return { ok: false, issues, message: formatIssues(issues) };
}

/** 校验 YAML 源文本。非法值报出所在行号（spec §9.2）。 */
export function validateStrategyYaml(src: string, filename?: string): ValidateResult {
  let parsedYaml: unknown;
  let idx: YamlIndex | null = null;
  try {
    parsedYaml = load(src, filename === undefined ? {} : { filename });
    idx = indexYaml(src, filename);
  } catch (e) {
    // 语法错就没有键路径可言，只有 mark。mark.line 是 0 起的，转成 1 起。
    const ex = e as YAMLException;
    const line = ex.mark !== undefined && typeof ex.mark.line === "number" ? ex.mark.line + 1 : null;
    const column = ex.mark !== undefined && typeof ex.mark.column === "number" ? ex.mark.column + 1 : null;
    const issues: ValidationIssue[] = [{
      path: [], line, column,
      message: `YAML 解析失败：${ex.reason ?? (e as Error).message}`,
    }];
    return { ok: false, issues, message: formatIssues(issues) };
  }

  if (parsedYaml === null || typeof parsedYaml !== "object" || Array.isArray(parsedYaml)) {
    const issues: ValidationIssue[] = [{
      path: [], line: 1, column: 1, message: "策略配置的顶层必须是一个映射",
    }];
    return { ok: false, issues, message: formatIssues(issues) };
  }

  const cfg = parsedYaml as Raw;
  const parsed = StrategyConfigSchema.safeParse(parsedYaml);
  const raw = issuesFrom(parsed, cfg);
  if (raw.length === 0) {
    return { ok: true, config: parsed.data as unknown as StrategyConfig, issues: [] };
  }

  const issues: ValidationIssue[] = raw.map(r => {
    // 定位不到就沿路径往上退到最近的祖先 —— "第 11 行的 组合风控 段少了 X"
    // 远比"行号未知"有用
    const span = locate(idx!, r.path);
    return {
      ...r,
      line: span === null ? null : span.line,
      column: span === null ? null : span.column,
    };
  });
  return { ok: false, issues, message: formatIssues(issues) };
}
