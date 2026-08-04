/**
 * .ptstrat 策略包的导入导出（spec §9.2）。
 *
 * 与 .ptbak **分开导出**：策略是逻辑资产（规则 + 参数 + 因子版本），
 * 数据是历史资产（几百万行行情）。两者搬运频率、体积、丢失代价都不同，
 * 打成一个包会让"我只想把这套参数发给另一台机器"变成搬几百 MB。
 *
 * 容器格式用单个 JSON 文件而不是 zip：不引新依赖，且策略包本来就只有几 KB。
 * 代价是 YAML 以字符串形式嵌在 JSON 里 —— 换来的是注释与排版原样保留，
 * 这正是 D7"YAML 是唯一真相源"要的效果（导进来的还是那份带注释的 YAML）。
 *
 * 导入三重校验，任一不过就是不过：
 *   1. schema 版本兼容（主版本必须相同）
 *   2. 引用的因子全部存在且版本一致 —— 版本漂移会让回测成绩对得上而实盘行为变了
 *   3. 参数在合法区间（带行号）
 * 外加一条完整性校验：payload 的 sha256 必须与 meta 对得上。
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import type { BacktestReport } from "@/lib/contracts/backtest";
import type { FactorRegistry } from "@/lib/contracts/factor";
import type { StrategyConfig } from "@/lib/contracts/strategy";
import {
  validateStrategyYaml, formatIssues, type ValidationIssue,
} from "@/lib/strategy/schema";

/** 策略包结构版本。主版本变化 = 不兼容改动 */
export const STRATEGY_SCHEMA_VERSION = "1.0.0";

export const PTSTRAT_EXT = ".ptstrat";

export interface PackageMeta {
  schema_version: string;
  author: string;
  created_at: string;
  /** payload（yaml + lock + report + 其余 meta 字段）的 sha256 */
  sha256: string;
}

export interface StrategyPackage {
  "strategy.yaml": string;
  /** 因子名 → 版本。防止导入后因子缺失或语义漂移 */
  "factors.lock": Record<string, string>;
  "backtest_report.json"?: BacktestReport;
  meta: PackageMeta;
}

export interface ExportInput {
  yaml: string;
  lock: Record<string, string>;
  report?: BacktestReport;
  author: string;
  /**
   * ISO 时间戳，**必须由调用方给**。
   * 在这里取系统时间的话，同一份策略每次导出的 sha256 都不同，
   * "两份包是不是同一套参数"就没法靠校验和回答了。
   */
  createdAt: string;
  schemaVersion?: string;
}

/** 排序输出，保证两台机器导出的字节序一致（sha256 才有意义） */
function sortedLock(lock: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of Object.keys(lock).sort()) out[k] = lock[k];
  return out;
}

/** 参与哈希的 payload。meta.sha256 自己不算在内，否则自指 */
function payloadOf(pkg: StrategyPackage): string {
  return JSON.stringify({
    "strategy.yaml": pkg["strategy.yaml"],
    "factors.lock": sortedLock(pkg["factors.lock"]),
    "backtest_report.json": pkg["backtest_report.json"] ?? null,
    schema_version: pkg.meta.schema_version,
    author: pkg.meta.author,
    created_at: pkg.meta.created_at,
  });
}

export function packagePayloadSha256(pkg: StrategyPackage): string {
  return createHash("sha256").update(payloadOf(pkg)).digest("hex");
}

export function exportStrategyPackage(input: ExportInput): StrategyPackage {
  if (typeof input.createdAt !== "string" || input.createdAt.length === 0) {
    throw new Error("exportStrategyPackage: 必须显式传 createdAt（created_at），不在这里取系统时间");
  }
  if (typeof input.author !== "string" || input.author.length === 0) {
    throw new Error("exportStrategyPackage: 必须给 author");
  }
  // 导出前先校验：允许导出一份非法策略 = 把问题快递给下一台机器
  const v = validateStrategyYaml(input.yaml);
  if (!v.ok) {
    throw new Error(`导出被拒：策略配置不合法\n${formatIssues(v.issues)}`);
  }

  const pkg: StrategyPackage = {
    "strategy.yaml": input.yaml,
    "factors.lock": sortedLock(input.lock),
    meta: {
      schema_version: input.schemaVersion ?? STRATEGY_SCHEMA_VERSION,
      author: input.author,
      created_at: input.createdAt,
      sha256: "",
    },
  };
  if (input.report !== undefined) pkg["backtest_report.json"] = input.report;
  pkg.meta.sha256 = packagePayloadSha256(pkg);
  return pkg;
}

/* -------------------------------- 序列化 -------------------------------- */

export function serializeStrategyPackage(pkg: StrategyPackage): string {
  // 键顺序固定写出，别依赖对象字面量顺序
  const ordered: Record<string, unknown> = {
    "strategy.yaml": pkg["strategy.yaml"],
    "factors.lock": sortedLock(pkg["factors.lock"]),
  };
  if (pkg["backtest_report.json"] !== undefined) {
    ordered["backtest_report.json"] = pkg["backtest_report.json"];
  }
  ordered["meta"] = {
    schema_version: pkg.meta.schema_version,
    author: pkg.meta.author,
    created_at: pkg.meta.created_at,
    sha256: pkg.meta.sha256,
  };
  return `${JSON.stringify(ordered, null, 2)}\n`;
}

export function parseStrategyPackage(text: string): StrategyPackage {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new Error(`策略包解析失败：不是合法 JSON（${(e as Error).message}）`);
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("策略包解析失败：顶层格式不对，应为一个对象");
  }
  const o = raw as Record<string, unknown>;
  if (typeof o["strategy.yaml"] !== "string" || o["strategy.yaml"].length === 0) {
    throw new Error("策略包缺少 strategy.yaml");
  }
  const lockRaw = o["factors.lock"];
  if (lockRaw === null || typeof lockRaw !== "object" || Array.isArray(lockRaw)) {
    throw new Error("策略包缺少 factors.lock");
  }
  const metaRaw = o["meta"];
  if (metaRaw === null || typeof metaRaw !== "object" || Array.isArray(metaRaw)) {
    throw new Error("策略包缺少 meta");
  }
  const m = metaRaw as Record<string, unknown>;
  const lock: Record<string, string> = {};
  for (const [k, v] of Object.entries(lockRaw as Record<string, unknown>)) {
    if (typeof v !== "string") throw new Error(`factors.lock 的 ${k} 版本不是字符串`);
    lock[k] = v;
  }
  const pkg: StrategyPackage = {
    "strategy.yaml": o["strategy.yaml"],
    "factors.lock": lock,
    meta: {
      schema_version: typeof m["schema_version"] === "string" ? m["schema_version"] : "",
      author: typeof m["author"] === "string" ? m["author"] : "",
      created_at: typeof m["created_at"] === "string" ? m["created_at"] : "",
      sha256: typeof m["sha256"] === "string" ? m["sha256"] : "",
    },
  };
  if (o["backtest_report.json"] !== undefined && o["backtest_report.json"] !== null) {
    pkg["backtest_report.json"] = o["backtest_report.json"] as BacktestReport;
  }
  return pkg;
}

export function writeStrategyPackage(filePath: string, pkg: StrategyPackage): void {
  fs.writeFileSync(filePath, serializeStrategyPackage(pkg));
}

export function readStrategyPackage(filePath: string): StrategyPackage {
  if (!fs.existsSync(filePath)) throw new Error(`策略包不存在：${filePath}`);
  return parseStrategyPackage(fs.readFileSync(filePath, "utf8"));
}

/* --------------------------------- 导入 --------------------------------- */

export interface ImportOptions {
  registry: FactorRegistry;
  /** 本机的 schema 版本，默认 STRATEGY_SCHEMA_VERSION。测试与迁移场景可覆盖 */
  localSchemaVersion?: string;
  /** 只在明确知道包被人手改过时才关。默认必须对得上 */
  skipChecksum?: boolean;
}

export interface ImportResult {
  ok: boolean;
  /** 三重校验全过才有值 */
  config: StrategyConfig | null;
  /** 参数区间问题，带行号 */
  issues: ValidationIssue[];
  schemaError: string | null;
  missingFactors: string[];
  mismatchedFactors: Array<{ name: string; expected: string; actual: string }>;
  /** 因子缺失/版本不匹配时的迁移提示（spec §9.2） */
  migrationHint: string | null;
  checksumError: string | null;
  /** 给人看的汇总，UI 直接显示 */
  message: string;
}

const majorOf = (v: string): string => v.split(".")[0] ?? "";

export function importStrategyPackage(
  pkg: StrategyPackage, opts: ImportOptions
): ImportResult {
  const local = opts.localSchemaVersion ?? STRATEGY_SCHEMA_VERSION;
  const lines: string[] = [];

  /* 0. 完整性 */
  let checksumError: string | null = null;
  if (opts.skipChecksum !== true) {
    const actual = packagePayloadSha256(pkg);
    if (pkg.meta.sha256.length === 0) {
      checksumError = "策略包 meta.sha256 为空，无法确认内容未被改动";
    } else if (actual !== pkg.meta.sha256) {
      checksumError =
        `策略包内容与 meta.sha256 不一致（包内 ${pkg.meta.sha256.slice(0, 12)}…，` +
        `实算 ${actual.slice(0, 12)}…）—— 内容被改过且没重算校验和`;
    }
    if (checksumError !== null) lines.push(checksumError);
  }

  /* 1. schema 版本 */
  let schemaError: string | null = null;
  if (majorOf(pkg.meta.schema_version) !== majorOf(local)) {
    schemaError =
      `策略包 schema 版本 ${pkg.meta.schema_version} 与本机 ${local} 主版本不同，不兼容`;
    lines.push(schemaError);
  }

  /* 3. 参数区间（先解析，因子参数段要用到）*/
  const v = validateStrategyYaml(pkg["strategy.yaml"]);
  const issues = v.ok ? [] : v.issues;
  if (!v.ok) lines.push(formatIssues(v.issues));

  /* 2. 引用因子 */
  const referenced = new Set<string>(Object.keys(pkg["factors.lock"]));
  if (v.ok && v.config.因子参数 !== undefined) {
    // YAML 里给某因子调了参数，就等于引用了它 —— 哪怕 lock 里漏写了
    for (const name of Object.keys(v.config.因子参数)) referenced.add(name);
  }
  const missingFactors: string[] = [];
  const mismatchedFactors: Array<{ name: string; expected: string; actual: string }> = [];
  for (const name of [...referenced].sort()) {
    const spec = opts.registry.get(name);
    if (spec === undefined) { missingFactors.push(name); continue; }
    const expected = pkg["factors.lock"][name];
    if (expected !== undefined && expected !== spec.version) {
      mismatchedFactors.push({ name, expected, actual: spec.version });
    }
  }

  let migrationHint: string | null = null;
  if (missingFactors.length > 0 || mismatchedFactors.length > 0) {
    const parts: string[] = [];
    if (missingFactors.length > 0) {
      parts.push(`缺失因子：${missingFactors.join(" / ")}（本机注册表里没有，需要先实现或改策略引用）`);
    }
    for (const m of mismatchedFactors) {
      parts.push(
        `因子 ${m.name} 版本不匹配：包要求 ${m.expected}，本机 ${m.actual} —— ` +
        `本机最近可用版本是 ${m.actual}；用它跑出来的信号与包里的回测成绩不可比，` +
        `要么升级/降级因子到 ${m.expected}，要么在本机重跑一遍回测再对比`
      );
    }
    migrationHint = parts.join("\n");
    lines.push(migrationHint);
  }

  const ok = checksumError === null && schemaError === null &&
    issues.length === 0 && missingFactors.length === 0 && mismatchedFactors.length === 0;

  return {
    ok,
    config: ok && v.ok ? v.config : null,
    issues, schemaError, missingFactors, mismatchedFactors, migrationHint, checksumError,
    message: ok ? "策略包校验通过" : lines.join("\n"),
  };
}
