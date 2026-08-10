import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { StrategyConfig, AccountType } from "@/lib/contracts/strategy";
import { getConfig } from "@/lib/config";
import { unavailable, type Avail } from "@/lib/ui/derive";
import {
  StrategyConfigError,
  accountRule,
  defaultStrategyPath,
  loadStrategyFile,
  writeStrategyParam as loaderWriteParam,
  type ParamValue,
} from "@/lib/strategy/loader";
import {
  formatIssue,
  normalizeAccountKey,
  validateStrategyConfig,
  validateStrategyYaml,
} from "@/lib/strategy/schema";
import { activeStrategyPath, strategyPath } from "@/lib/strategy/registry";
import { BACKUP_DIR_NAME, backupFile, listBackups, stampOf, type BackupResult } from "@/lib/backup/strategy-file";

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

/**
 * 当前生效策略的相对路径，**只用于显示**。
 *
 * 以前这是个写死的常量 `config/strategy.yaml`。策略改成可增删之后那个字符串就在骗人：
 * 界面上写着 config/strategy.yaml，用户去改那个文件却发现没生效（真相源已经是
 * config/strategies/<id>.yaml）。提示文案指错文件比不给提示更耗时间，所以它必须跟着 active 走。
 */
export function strategyYamlRel(): string {
  const p = activeStrategyPath();
  return p === null ? "config/strategies/<id>.yaml" : path.relative(PROJECT_ROOT, p);
}

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
  /** 写前备份落在哪。界面要显示出来，否则用户不知道退路在哪 */
  backupPath?: string;
}

/** 备份目录：dataDir/strategy-backups。为什么落这儿见 lib/backup/strategy-file.ts 顶部 */
export function backupDir(): string {
  return path.join(getConfig().dataDir, BACKUP_DIR_NAME);
}

/**
 * 写前备份。**任何改动 YAML 的路径都要先过这里**，包括只改一个纯量的参数面板 ——
 * "只改一个数"照样能把 0.05 改成 5 然后关掉窗口，那时唯一能救的就是这份副本。
 *
 * 备份失败即中止写入，不"尽力而为地继续"：留不下退路的改动不该发生。
 */
function backupBeforeWrite(filePath: string, now: Date): BackupResult {
  return backupFile(filePath, backupDir(), now);
}

/**
 * 参数写回 YAML。
 *
 * 委派给 loader 的 writeStrategyParam：它在**原文上替换纯量**（保留注释与排版）、
 * 改完整份重新校验、临时文件 + rename 落盘。这三条都不能少：
 * 注释记着每个阈值的由来；不校验就等于允许面板把唯一真相源改成非法状态；
 * 不用 rename 就可能留下半份被截断的配置。
 */
export function writeStrategyParam(
  paramPath: string[],
  value: unknown,
  now: Date = new Date()
): WriteResult {
  if (paramPath.length === 0) return { ok: false, reason: "参数路径为空" };
  if (typeof value !== "number" && typeof value !== "boolean" && typeof value !== "string") {
    return {
      ok: false,
      reason: "只支持写纯量（数字/布尔/字符串）。列表与整段规则请直接编辑 YAML —— 自动改写需要猜缩进与注释归属",
    };
  }
  const p = strategyYamlPath();
  let backup: BackupResult;
  try {
    backup = backupBeforeWrite(p, now);
  } catch (e) {
    return { ok: false, reason: `写前备份失败，已中止写入：${(e as Error).message}` };
  }
  try {
    loaderWriteParam(p, paramPath, value as ParamValue);
    return { ok: true, backupPath: backup.path };
  } catch (e) {
    if (e instanceof StrategyConfigError) {
      return { ok: false, reason: "写入后校验不通过，已回滚（未落盘）", issues: e.issues };
    }
    return { ok: false, reason: (e as Error).message };
  }
}

export interface RawReadResult {
  id: string;
  filePath: string;
  raw: string;
  /** 原文摘要。编辑器保存时带回来做乐观并发校验 */
  hash: string;
  mtime: string;
  backups: Array<{ name: string; bytes: number; mtime: string }>;
}

/** 原文摘要。只用于"我编辑的还是不是我读到的那一份"，不做安全用途 */
export function rawHash(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex").slice(0, 16);
}

/**
 * 读某个策略的**原文**（不校验，校验不过也要能读到 —— 正是那种时候才需要编辑器）。
 */
export function readStrategyRawById(id: string): RawReadResult | { error: string } {
  let p: string;
  try {
    p = strategyPath(id);
  } catch (e) {
    return { error: (e as Error).message };
  }
  if (!fs.existsSync(p)) return { error: `策略不存在：${id}（${p}）` };
  const raw = fs.readFileSync(p, "utf8");
  const st = fs.statSync(p);
  return {
    id,
    filePath: p,
    raw,
    hash: rawHash(raw),
    mtime: new Date(st.mtimeMs).toISOString(),
    backups: listBackups(backupDir(), path.basename(p)).map(({ name, bytes, mtime }) => ({ name, bytes, mtime })),
  };
}

export interface RawWriteResult {
  ok: boolean;
  reason?: string;
  issues?: unknown;
  /** 落盘用的备份路径；dryRun 时是"将会写到哪" */
  backupPath?: string;
  hash?: string;
  /** 409 语义：磁盘上的原文已经不是编辑器读到的那份 */
  conflict?: boolean;
}

/**
 * 整份原文写回。P0 的核心：一屏文本覆盖新增键 / 改列表 / 改整段规则，
 * 而**注释保全是天然的** —— 是人在改文本，没有任何程序去猜缩进与注释归属。
 *
 * 落盘顺序（任一环节失败都不写）：
 *   1. id 一致性  —— 文件名是 id，正文 `id:` 必须与之相同，否则 registry 读到的
 *                    id 和文件名分叉，界面上"生效中"指的是谁就说不清了；
 *   2. 乐观并发   —— baseHash 对不上说明磁盘上那份已经被改过（手工编辑 / 另一个标签页），
 *                    直接覆盖等于静默吃掉别人的改动；
 *   3. 整份校验   —— 带行号返回，非法就一个字节都不落盘；
 *   4. 写前备份   —— 见 backupBeforeWrite；
 *   5. 临时文件 + rename —— 半份 YAML 落盘会让系统下次读配置直接失败。
 */
export function writeStrategyRaw(
  id: string,
  text: string,
  baseHash: string,
  opts: { dryRun?: boolean; now?: Date } = {}
): RawWriteResult {
  const now = opts.now ?? new Date();
  let p: string;
  try {
    p = strategyPath(id);
  } catch (e) {
    return { ok: false, reason: (e as Error).message };
  }
  if (!fs.existsSync(p)) return { ok: false, reason: `策略不存在：${id}（${p}）` };

  const current = fs.readFileSync(p, "utf8");
  if (rawHash(current) !== baseHash) {
    return {
      ok: false,
      conflict: true,
      reason:
        "磁盘上的原文已经变了（有人手工改过文件，或另一个标签页保存过）。" +
        "为避免覆盖掉那次改动，这里不写 —— 请重新载入原文，把你的修改重做一遍。",
      hash: rawHash(current),
    };
  }

  const v = validateStrategyYaml(text, p);
  if (!v.ok) {
    return { ok: false, reason: `校验不通过（${v.issues.length} 处），未落盘`, issues: v.issues };
  }
  if (v.config.id !== id) {
    return {
      ok: false,
      reason:
        `正文里的 id 是 ${JSON.stringify(v.config.id)}，与文件名 ${id} 不一致。` +
        "文件名就是策略 id，两者分叉会让「现在跑的是哪个策略」说不清 —— " +
        "要改 id 请用「新建策略（复制自）」，再删掉旧的。",
    };
  }

  if (opts.dryRun === true) {
    return {
      ok: true,
      backupPath: path.join(backupDir(), `${path.basename(p)}.${stampOf(now)}`),
      hash: rawHash(text),
    };
  }

  let backup: BackupResult;
  try {
    backup = backupBeforeWrite(p, now);
  } catch (e) {
    return { ok: false, reason: `写前备份失败，已中止写入：${(e as Error).message}` };
  }
  const tmp = `${p}.tmp`;
  fs.writeFileSync(tmp, text, "utf8");
  fs.renameSync(tmp, p);
  return { ok: true, backupPath: backup.path, hash: rawHash(text) };
}

/**
 * 在配置的**深拷贝**上按点路径覆盖若干纯量，并整份重新校验。
 *
 * 给参数扫描用：一个网格点 = 一组覆盖。三条不能省 ——
 *   1. 深拷贝：直接改传进来的 config，会让同一次扫描里前一个网格点污染后一个，
 *      而症状是"热力图数字不对"，几乎查不出来；
 *   2. 路径必须已存在：不存在就是用户写错了轴名，静默新建一个键等于扫了个
 *      引擎根本不读的参数，图还照画；
 *   3. 覆盖后整份走 schema：`择时.仓位档位.进攻 = 5` 这种越界值必须当场拒，
 *      否则回测会拿一份非法配置跑出一条看起来正常的净值曲线。
 */
export function overrideConfigParams(
  config: StrategyConfig,
  overrides: Record<string, unknown>
): { ok: true; config: StrategyConfig } | { ok: false; reason: string } {
  const next = JSON.parse(JSON.stringify(config)) as Record<string, unknown>;
  for (const [dotted, value] of Object.entries(overrides)) {
    const segs = dotted.split(".");
    let node: Record<string, unknown> = next;
    for (const s of segs.slice(0, -1)) {
      const child = node[s];
      if (child === null || typeof child !== "object" || Array.isArray(child)) {
        return { ok: false, reason: `参数路径不存在：${dotted}（在 ${s} 处断了）` };
      }
      node = child as Record<string, unknown>;
    }
    const leaf = segs[segs.length - 1];
    if (!(leaf in node)) return { ok: false, reason: `参数路径不存在：${dotted}` };
    const cur = node[leaf];
    if (cur !== null && typeof cur === "object") {
      return { ok: false, reason: `${dotted} 不是纯量，扫描只支持纯量轴` };
    }
    node[leaf] = value;
  }
  const v = validateStrategyConfig(next);
  if (!v.ok) {
    return {
      ok: false,
      reason: `覆盖后配置非法（${v.issues.length} 处）：${v.issues.map(formatIssue).join("；")}`,
    };
  }
  return { ok: true, config: v.config };
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
 * 某账户的规则段。走 loader 的 accountRule —— 它同时认 "卫星" 与 "卫星账户"
 * 两种键写法（spec §9.1 的 YAML 用后者，契约类型用前者）。
 * 读不到就返回空对象，**不套内置默认止损线**：内置默认会让人以为那是自己设的线。
 */
/**
 * YAML 持仓段里配了规则的所有账户。键取自用户的 YAML，**不预设任何账户名** ——
 * 早期版本这里写死两个内置账户名，用户改个账户名规则就静默读不到、
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
