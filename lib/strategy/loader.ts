/**
 * strategy.yaml 的加载 / 热加载 / 写回。
 *
 * D7：YAML 是唯一真相源，参数面板只是它的投影。所以这一层要同时满足两件事：
 *   - 读：任何时候读到的都是磁盘上那一份（热加载），不缓存出第二份状态。
 *   - 写：面板改一个参数 = 在原文上替换一个纯量。**注释与排版一个字节不动。**
 *
 * 为什么写回不走 load→dump：js-yaml 的往返会丢掉全部注释与 flow 风格排版。
 * strategy.yaml 的注释记的是"为什么是这个阈值"（几次真金白银的复盘换来的），
 * 冲掉它们的代价高于面板改参的便利。所以写回是外科手术式的文本替换，
 * 改不了就抛错（新增键、改整段结构），绝不退化成整份 dump。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AccountType, StrategyConfig } from "@/lib/contracts/strategy";
import {
  DEFAULT_STRATEGY_YAML_REL, normalizeAccountKey,
  validateStrategyYaml, formatIssues, type ValidationIssue,
} from "@/lib/strategy/schema";
import { indexYaml, type YamlSpan } from "@/lib/strategy/yaml-pos";

/** 校验不过时抛这个。issues 带行号，UI 可以直接高亮到那一行。 */
export class StrategyConfigError extends Error {
  readonly issues: ValidationIssue[];
  readonly filePath: string | null;
  constructor(issues: ValidationIssue[], filePath: string | null) {
    const where = filePath === null ? "" : `${filePath}\n`;
    super(`策略配置校验失败：\n${where}${formatIssues(issues)}`);
    this.name = "StrategyConfigError";
    this.issues = issues;
    this.filePath = filePath;
  }
}

export interface LoadedStrategy {
  config: StrategyConfig;
  /** 原文。参数面板旁边直接显示，让用户看见自己改的就是这份文件 */
  raw: string;
  filePath: string | null;
}

/** 项目根：本文件在 lib/strategy/ 下，往上两级 */
function projectRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
}

export function defaultStrategyPath(): string {
  return path.join(projectRoot(), DEFAULT_STRATEGY_YAML_REL);
}

export function parseStrategy(src: string, filePath: string | null = null): LoadedStrategy {
  const r = validateStrategyYaml(src, filePath ?? undefined);
  if (!r.ok) throw new StrategyConfigError(r.issues, filePath);
  return { config: r.config, raw: src, filePath };
}

export function loadStrategyFile(filePath: string = defaultStrategyPath()): LoadedStrategy {
  if (!fs.existsSync(filePath)) {
    // 不返回内置默认配置：那会让"我改了 YAML 怎么没生效"变成无法排查的问题
    throw new Error(`策略配置文件不存在：${filePath}`);
  }
  return parseStrategy(fs.readFileSync(filePath, "utf8"), filePath);
}

/* -------------------------------- 热加载 -------------------------------- */

export interface StrategyStore {
  /** 每次调用都检查文件是否变过；变了就重新解析。校验不过时抛 StrategyConfigError */
  get(): StrategyConfig;
  raw(): string;
  /** 最后一份通过校验的配置。盘中改坏参数时用它降级，别让整套盘面停摆 */
  last(): StrategyConfig | null;
  lastError(): StrategyConfigError | null;
  reload(): StrategyConfig;
  stats(): { parses: number };
  filePath: string;
}

/**
 * 热加载用 mtime+size 比对，不用 fs.watch。
 *
 * 理由：fs.watch 在 macOS 上对编辑器的"写临时文件再 rename"会漏事件或重复触发，
 * 还要管监听器生命周期；而这个系统每次决策才读一次配置，
 * 读时 stat 一下是 O(μs)，行为完全确定，也不引入定时器。
 */
export function createStrategyStore(filePath: string = defaultStrategyPath()): StrategyStore {
  let sig = "";
  let cached: StrategyConfig | null = null;
  let cachedRaw = "";
  let lastGood: StrategyConfig | null = null;
  let lastErr: StrategyConfigError | null = null;
  let parses = 0;

  const signature = (): string => {
    const st = fs.statSync(filePath);
    return `${st.mtimeMs}:${st.size}`;
  };

  const doLoad = (): StrategyConfig => {
    const s = loadStrategyFile(filePath);
    cached = s.config;
    cachedRaw = s.raw;
    lastGood = s.config;
    lastErr = null;
    parses++;
    return s.config;
  };

  const refresh = (force: boolean): StrategyConfig => {
    const cur = signature();
    if (!force && cur === sig && cached !== null) return cached;
    sig = cur;
    try {
      return doLoad();
    } catch (e) {
      cached = null;
      if (e instanceof StrategyConfigError) lastErr = e;
      throw e;
    }
  };

  return {
    filePath,
    get: () => refresh(false),
    raw: () => { refresh(false); return cachedRaw; },
    reload: () => refresh(true),
    last: () => lastGood,
    lastError: () => lastErr,
    stats: () => ({ parses }),
  };
}

/* --------------------------------- 写回 --------------------------------- */

export type ParamValue = number | boolean | string;

/** 不加引号也能安全表达的纯量。判错的代价是产出坏 YAML，所以从严。 */
function plainSafe(s: string): boolean {
  if (s.length === 0) return false;
  if (s !== s.trim()) return false;
  if (/^[-?:,[\]{}#&*!|>'"%@`]/.test(s)) return false;
  if (/:\s|\s#/.test(s)) return false;
  if (/[:#,[\]{}]/.test(s)) return false;
  if (/[\n\r\t]/.test(s)) return false;
  // 看起来像数字/布尔/null 的字符串必须加引号，否则读回来就不是字符串了
  if (/^(true|false|null|~|yes|no|on|off)$/i.test(s)) return false;
  if (/^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(s)) return false;
  return true;
}

function formatScalar(v: ParamValue): string {
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw new Error(`不能写入非有限数字：${v}`);
    return String(v);
  }
  if (typeof v === "boolean") return v ? "true" : "false";
  return plainSafe(v) ? v : JSON.stringify(v);
}

/**
 * 在原文上替换一个纯量，返回新文本。
 *
 * path 里的序列下标用十进制字符串，如 ["选股","主线识别","必查链","1"]。
 * 目标不存在、或目标是一整段（映射/序列）时抛错 —— 见文件头注释：宁可拒绝写。
 */
export function writeParamInText(src: string, keyPath: string[], value: ParamValue): string {
  const idx = indexYaml(src);
  const key = keyPath.join(".");
  const span: YamlSpan | undefined = idx.byPath.get(key);
  if (span === undefined) {
    throw new Error(
      `写回失败：${key} 在配置里不存在。` +
      `新增参数请直接编辑 YAML —— 自动插入需要猜缩进与注释归属，猜错会破坏原文。`
    );
  }
  if (span.kind !== "scalar") {
    throw new Error(`写回失败：${key} 是一个 ${span.kind} 段落，不是纯量，不能整段替换`);
  }

  if (span.plain) {
    const text = formatScalar(value);
    return src.slice(0, span.valueStart) + text + src.slice(span.valueEnd);
  }

  // 带引号的纯量：只换引号里面的内容，引号与行尾注释都留在原位
  const quote = span.valueStart > 0 ? src[span.valueStart - 1] : "";
  if (quote !== '"' && quote !== "'") {
    throw new Error(`写回失败：${key} 是块状纯量（| 或 >），不支持原地替换`);
  }
  const raw = typeof value === "string" ? value : formatScalar(value);
  const inner = quote === '"'
    ? raw.replace(/\\/g, "\\\\").replace(/"/g, '\\"')
    : raw.replace(/'/g, "''");
  return src.slice(0, span.valueStart) + inner + src.slice(span.valueEnd);
}

/**
 * 落盘。先在内存里改、再整份校验，通过了才写 ——
 * 面板不该有能力把唯一真相源改成非法状态。
 */
export function writeStrategyParam(
  filePath: string, keyPath: string[], value: ParamValue
): string {
  const src = fs.readFileSync(filePath, "utf8");
  const next = writeParamInText(src, keyPath, value);
  const r = validateStrategyYaml(next, filePath);
  if (!r.ok) throw new StrategyConfigError(r.issues, filePath);
  // 先写临时文件再 rename：中途崩了也不会留下半份被截断的配置
  const tmp = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, next);
  fs.renameSync(tmp, filePath);
  return next;
}

/* ------------------------------ 账户规则读取 ------------------------------ */

/**
 * 取某账户的规则段。账户名由用户定义，这里不认任何固定名字，
 * 只按构词规则归一化（`贼王` 与 `贼王账户` 视为同一账户）。
 */
export function accountRule(
  cfg: StrategyConfig, account: AccountType
): Record<string, unknown> {
  const held = cfg.持仓 as unknown as Record<string, unknown>;
  if (held === undefined || held === null) return {};
  for (const [k, v] of Object.entries(held)) {
    if (normalizeAccountKey(k) === normalizeAccountKey(account)
        && v !== null && typeof v === "object") {
      return v as Record<string, unknown>;
    }
  }
  return {};
}

export interface TakeProfitRule {
  /** 触发的浮盈比例，0.08 = +8% */
  pnl: number;
  action: "减仓" | "清仓";
  raw: string;
}

/**
 * 解析 "0.08减半" / "0.15清" 这类止盈写法。
 *
 * 看不懂的写法**跳过**而不是猜：猜错会在赚钱的位置上砍掉仓位，
 * 而跳过只是少一条自动提示，人还在盘面上。跳过的原文由调用方从 raw 里拿去告警。
 */
export function takeProfitRules(cfg: StrategyConfig, account: AccountType): TakeProfitRule[] {
  const raw = accountRule(cfg, account)["止盈"];
  const items: string[] = Array.isArray(raw)
    ? raw.filter((x): x is string => typeof x === "string")
    : typeof raw === "string" ? [raw] : [];

  const out: TakeProfitRule[] = [];
  for (const item of items) {
    const m = /^\s*([-+]?\d*\.?\d+)\s*(.*)$/.exec(item);
    if (m === null) continue;
    const pnl = Number(m[1]);
    if (!Number.isFinite(pnl)) continue;
    const rest = m[2];
    const action = /清|全|平/.test(rest) ? "清仓" : /减|半/.test(rest) ? "减仓" : null;
    if (action === null) continue;
    out.push({ pnl, action, raw: item });
  }
  return out.sort((a, b) => a.pnl - b.pnl);
}

/** 无法解析的止盈写法原文，供信号卡告警"这条规则没生效" */
export function unparsedTakeProfit(cfg: StrategyConfig, account: AccountType): string[] {
  const raw = accountRule(cfg, account)["止盈"];
  const items: string[] = Array.isArray(raw)
    ? raw.filter((x): x is string => typeof x === "string")
    : typeof raw === "string" ? [raw] : [];
  const parsed = new Set(takeProfitRules(cfg, account).map(r => r.raw));
  return items.filter(i => !parsed.has(i));
}
