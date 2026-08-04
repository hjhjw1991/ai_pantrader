import fs from "node:fs";
import path from "node:path";
import type { StrategyConfig, AccountType } from "@/lib/contracts/strategy";
import { unavailable, type Avail } from "@/lib/ui/derive";
import {
  StrategyConfigError,
  accountRule,
  defaultStrategyPath,
  loadStrategyFile,
  writeStrategyParam as loaderWriteParam,
  type ParamValue,
} from "@/lib/strategy/loader";
import { normalizeAccountKey } from "@/lib/strategy/schema";

/**
 * strategy.yaml 适配器 —— 参数面板与策略层之间唯一的一层。
 *
 * D7：**YAML 是唯一真相源**。面板是它的投影，不存在第二份状态 ——
 * 这里既不缓存配置也不往 DB 落副本，每次都重新读文件。
 *
 * 校验、行号报错与保留注释的写回全部由 lib/strategy/loader 负责，
 * 本文件只做类型适配与"读不出来时给什么空态"。loader 换签名只改这一个文件。
 */

/** 只用于显示相对路径，不用来定位文件 —— 文件位置由 loader 的 defaultStrategyPath 决定 */
const PROJECT_ROOT = process.cwd();

export const STRATEGY_YAML_REL = "config/strategy.yaml";

export function strategyYamlPath(): string {
  return defaultStrategyPath();
}

export interface StrategyConfigResult {
  config: StrategyConfig;
  /** 原文，参数面板旁边直接显示，让用户看见自己改的就是这份文件 */
  raw: string;
  filePath: string;
  /** true = 经过 loader 的完整校验（含取值区间），不只是 YAML 语法 */
  validated: boolean;
}

export interface StrategyConfigInvalid {
  available: false;
  reason: string;
  needs?: string;
  /** 校验失败的逐条问题，带行号，界面可以直接指到那一行 */
  issues?: Array<{ path?: string; message: string; line?: number }>;
}

export function readStrategyConfig(): Avail<StrategyConfigResult> & { issues?: unknown } {
  const p = strategyYamlPath();
  if (!fs.existsSync(p)) {
    return unavailable(
      `策略配置文件不存在：${path.relative(PROJECT_ROOT, p)}`,
      "由策略层提供 config/strategy.yaml；它是参数的唯一真相源（D7）。前端不代为生成默认配置 —— 生成了会让「我改了 YAML 怎么没生效」变成无法排查的问题"
    );
  }
  try {
    const l = loadStrategyFile(p);
    return {
      available: true,
      config: l.config,
      raw: l.raw,
      filePath: l.filePath ?? p,
      validated: true,
    };
  } catch (e) {
    if (e instanceof StrategyConfigError) {
      // 校验不过时**不降级用部分配置**：半份合法的择时参数比没有更危险
      return {
        ...unavailable(
          `策略配置校验失败（${e.issues.length} 处）`,
          `修正 ${path.relative(PROJECT_ROOT, p)} 后刷新。逐条问题见下方，带行号`
        ),
        issues: e.issues,
      };
    }
    return unavailable(`读取策略配置失败：${(e as Error).message}`);
  }
}

/** loader 已在依赖树里，恒为 true。保留这个函数是因为页面文案要区分"没接上"与"没配置" */
export function loaderReady(): boolean {
  return true;
}

export interface WriteResult {
  ok: boolean;
  reason?: string;
  /** 校验失败时的逐条问题（带行号） */
  issues?: unknown;
}

/**
 * 参数写回 YAML。
 *
 * 委派给 loader 的 writeStrategyParam：它在**原文上替换纯量**（保留注释与排版）、
 * 改完整份重新校验、临时文件 + rename 落盘。这三条都不能少：
 * 注释记着每个阈值的由来；不校验就等于允许面板把唯一真相源改成非法状态；
 * 不用 rename 就可能留下半份被截断的配置。
 */
export function writeStrategyParam(paramPath: string[], value: unknown): WriteResult {
  if (paramPath.length === 0) return { ok: false, reason: "参数路径为空" };
  if (typeof value !== "number" && typeof value !== "boolean" && typeof value !== "string") {
    return {
      ok: false,
      reason: "只支持写纯量（数字/布尔/字符串）。列表与整段规则请直接编辑 YAML —— 自动改写需要猜缩进与注释归属",
    };
  }
  try {
    loaderWriteParam(strategyYamlPath(), paramPath, value as ParamValue);
    return { ok: true };
  } catch (e) {
    if (e instanceof StrategyConfigError) {
      return { ok: false, reason: "写入后校验不通过，已回滚（未落盘）", issues: e.issues };
    }
    return { ok: false, reason: (e as Error).message };
  }
}

/** 把嵌套配置摊平成 "择时.仓位档位.进攻" 这样的路径，面板按行渲染 */
export interface FlatParam {
  path: string;
  value: unknown;
  kind: "scalar" | "list" | "map";
}

export function flattenConfig(obj: unknown, prefix: string[] = []): FlatParam[] {
  const out: FlatParam[] = [];
  if (obj === null || obj === undefined) return out;
  if (Array.isArray(obj)) {
    out.push({ path: prefix.join("."), value: obj, kind: "list" });
    return out;
  }
  if (typeof obj === "object") {
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      if (v !== null && typeof v === "object" && !Array.isArray(v)) {
        out.push(...flattenConfig(v, [...prefix, k]));
      } else if (Array.isArray(v)) {
        out.push({ path: [...prefix, k].join("."), value: v, kind: "list" });
      } else {
        out.push({ path: [...prefix, k].join("."), value: v, kind: "scalar" });
      }
    }
    return out;
  }
  out.push({ path: prefix.join("."), value: obj, kind: "scalar" });
  return out;
}

/**
 * 某账户的规则段。走 loader 的 accountRule —— 它同时认 "贼王" 与 "贼王账户"
 * 两种键写法（spec §9.1 的 YAML 用后者，契约类型用前者）。
 * 读不到就返回空对象，**不套内置默认止损线**：内置默认会让人以为那是自己设的线。
 */
/**
 * YAML 持仓段里配了规则的所有账户。键取自用户的 YAML，**不预设任何账户名** ——
 * 早期版本这里写死 贼王/价值 两键，用户改个账户名规则就静默读不到、
 * 硬线告警跟着静默失效，而页面上看不出任何异常。
 */
export function accountRules(
  cfg: StrategyConfig | null
): Record<AccountType, Record<string, unknown>> {
  if (!cfg) return {};
  const held = (cfg as unknown as { 持仓?: Record<string, unknown> }).持仓;
  if (held === null || typeof held !== "object") return {};
  const out: Record<string, Record<string, unknown>> = {};
  for (const k of Object.keys(held)) {
    const norm = normalizeAccountKey(k);
    if (norm.length === 0) continue;
    out[norm] = accountRule(cfg, norm);
  }
  return out;
}
