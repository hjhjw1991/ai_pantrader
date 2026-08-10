import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateStrategyYaml, formatIssues } from "@/lib/strategy/schema";

/**
 * 本文件**只依赖 schema，不依赖 loader** —— loader 要向这里问"当前是哪个策略"，
 * 反过来引用就成环了。校验直接走 schema 的 validateStrategyYaml。
 */
function validated(text: string, filePath: string): { id: string; version: string } {
  const r = validateStrategyYaml(text, filePath);
  if (!r.ok) throw new Error(`策略校验失败（${r.issues.length} 处）：\n${formatIssues(r.issues)}`);
  return { id: r.config.id, version: r.config.version };
}

/**
 * 多策略登记处。**只管文件，一行存储都不碰。**
 *
 * 为什么策略是目录里的文件、而不是数据库里的行：D7 说 YAML 是唯一真相源，
 * 而 YAML 的注释记着每个阈值「为什么是这个数」—— 那些是真金白银的复盘换来的。
 * 存进库就得序列化，一旦有人用 js-yaml 往返，注释就全没了；
 * 文件还能 git diff、能直接编辑。
 *
 * 落盘布局：
 *   config/strategies/<id>.yaml   可编辑的真相源，可增可删
 *   config/strategies/ACTIVE      单行文本，当前在跑的是哪个
 *
 * 为什么删除只做到"删文件"这一层：删之前要看台账里有多少预测挂在它上面，
 * 那是查库的活，而 lib/strategy/ 的纯度断言（spec §17 断言 3）不许碰存储 ——
 * 决策层碰了库，回测就不再可复现。所以删除被切成两半：
 *   本文件                             拒绝规则 + removeStrategyFile（纯文件）
 *   lib/ledger/strategy-snapshot.ts    查引用、快照、编排删除（碰库）
 */

/** ACTIVE 指针文件名。不用点开头，要让用户在目录里一眼看见 */
export const ACTIVE_POINTER = "ACTIVE";
export const STRATEGIES_DIR_REL = "config/strategies";
/** 迁移前的单文件位置，仍然认 */
export const LEGACY_YAML_REL = "config/strategy.yaml";

/**
 * config/ 所在的根目录。
 *
 * 默认是项目根（本文件在 lib/strategy/ 下，往上两级）。
 * PANTRADER_CONFIG_ROOT 可以整体挪走 —— 测试靠它指到临时目录，
 * 从而测的是真实的读写与拒绝规则，而不是被 mock 掉的判断逻辑。
 */
export function configRoot(): string {
  const override = process.env.PANTRADER_CONFIG_ROOT;
  if (override !== undefined && override !== "") return override;
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
}

export function strategiesDir(): string {
  return path.join(configRoot(), STRATEGIES_DIR_REL);
}

export function legacyYamlPath(): string {
  return path.join(configRoot(), LEGACY_YAML_REL);
}

/**
 * 策略 id 必须能安全当文件名。
 * 这不是洁癖：id 直接拼进路径，`../../etc/passwd` 或 `a/b` 就能写到目录外去。
 */
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function assertSafeId(id: string): void {
  if (!ID_RE.test(id)) {
    throw new Error(
      `策略 id 不合法：${JSON.stringify(id)}。只允许字母数字与 . _ -，首字符须为字母或数字，最长 64 ——`
      + ` id 会直接作为文件名拼进路径`
    );
  }
  if (id === ACTIVE_POINTER) throw new Error(`策略 id 不能叫 ${ACTIVE_POINTER}，那是指针文件`);
}

export function strategyPath(id: string): string {
  assertSafeId(id);
  return path.join(strategiesDir(), `${id}.yaml`);
}

export interface StrategyFile {
  id: string;
  filePath: string;
  /** 文件里写的 version。读不出来（校验不过）时为 null */
  version: string | null;
  active: boolean;
  /** 校验通过与否。不通过也要列出来 —— 藏起来用户就不知道该去修哪个文件 */
  valid: boolean;
  invalidReason?: string;
  mtime: string;
  bytes: number;
}

/**
 * 列出全部策略。
 *
 * 兼容老布局：只有 config/strategy.yaml、还没有 strategies/ 目录时，
 * 把它当作一个策略列出来（id 取文件里写的 id）。不静默迁移文件 ——
 * 移动用户的真相源必须是显式动作，见 migrateLegacy()。
 */
export function listStrategies(): StrategyFile[] {
  const dir = strategiesDir();
  const out: StrategyFile[] = [];
  const active = activeStrategyId();

  const add = (filePath: string, id: string) => {
    let version: string | null = null;
    let valid = false;
    let invalidReason: string | undefined;
    try {
      version = validated(fs.readFileSync(filePath, "utf8"), filePath).version;
      valid = true;
    } catch (e) {
      invalidReason = (e as Error).message.split("\n")[0];
    }
    const st = fs.statSync(filePath);
    out.push({
      id, filePath, version, valid, invalidReason,
      active: id === active,
      mtime: new Date(st.mtimeMs).toISOString(),
      bytes: st.size,
    });
  };

  if (fs.existsSync(dir)) {
    for (const f of fs.readdirSync(dir).sort()) {
      if (!f.endsWith(".yaml")) continue;
      add(path.join(dir, f), f.slice(0, -".yaml".length));
    }
  }
  // 老单文件：目录里没有同 id 的才补上，避免迁移后重复
  const legacy = legacyYamlPath();
  if (fs.existsSync(legacy)) {
    const id = "default";
    if (!out.some(s => s.id === id)) add(legacy, id);
  }
  return out;
}

/**
 * 当前在跑哪个策略。
 *
 * 指针放文件而不是 app_meta 表：app_meta 是"本机配置"，被 .ptbak 显式排除，
 * 换台机器恢复后 active 就丢了，系统会突然按另一个策略给信号 —— 那是最坏的一种静默。
 * 放 config/ 下随源码走，git 里看得见，导出策略包时也带得上。
 */
export function activeStrategyId(): string | null {
  const p = path.join(strategiesDir(), ACTIVE_POINTER);
  if (fs.existsSync(p)) {
    const id = fs.readFileSync(p, "utf8").trim();
    if (id && fs.existsSync(path.join(strategiesDir(), `${id}.yaml`))) return id;
  }
  // 没有指针时：目录里只有一个策略就用它；否则退回老单文件
  const dir = strategiesDir();
  if (fs.existsSync(dir)) {
    const files = fs.readdirSync(dir).filter(f => f.endsWith(".yaml")).sort();
    if (files.length === 1) return files[0].slice(0, -".yaml".length);
    if (files.length > 1) return null;   // 多个而没有指针 = 未决，调用方须报错而不是猜
  }
  return fs.existsSync(legacyYamlPath()) ? "default" : null;
}

/** 当前策略的文件路径。null = 一个策略都没有，或有多个但没选 */
export function activeStrategyPath(): string | null {
  const id = activeStrategyId();
  if (id === null) return null;
  const p = path.join(strategiesDir(), `${id}.yaml`);
  if (fs.existsSync(p)) return p;
  const legacy = legacyYamlPath();
  return id === "default" && fs.existsSync(legacy) ? legacy : null;
}

export function setActiveStrategy(id: string): void {
  assertSafeId(id);
  const p = strategyPath(id);
  if (!fs.existsSync(p)) throw new Error(`策略不存在：${id}（${p}）`);
  // 切换前先校验：切到一个校验不过的策略等于让系统立刻停止出信号，
  // 而用户以为自己只是换了个参数集
  validated(fs.readFileSync(p, "utf8"), p);
  fs.mkdirSync(strategiesDir(), { recursive: true });
  atomicWrite(path.join(strategiesDir(), ACTIVE_POINTER), `${id}\n`);
}

/** 临时文件 + rename：半份 YAML 落盘会让系统下一次读配置直接失败 */
function atomicWrite(target: string, text: string): void {
  const tmp = `${target}.tmp`;
  fs.writeFileSync(tmp, text, "utf8");
  fs.renameSync(tmp, target);
}

/**
 * 把 `id:` 那一行换成新 id，其余字节不动。
 *
 * 不用 js-yaml 重新 dump —— 那会冲掉全部注释，而新建策略的全部价值
 * 就在于「带着那些解释为什么的注释开始改」。改不了就抛错，不退化成整份 dump。
 */
export function rewriteIdLine(src: string, newId: string): string {
  const lines = src.split("\n");
  let hit = -1;
  for (let i = 0; i < lines.length; i++) {
    // 只认顶层的 id（行首无缩进），嵌套里的 id 不是策略 id
    if (/^id\s*:/.test(lines[i])) { hit = i; break; }
  }
  if (hit < 0) throw new Error("源策略里找不到顶层 `id:` 行，无法安全改写 —— 请手工建文件");
  lines[hit] = lines[hit].replace(/^id\s*:.*$/, `id: ${newId}`);
  return lines.join("\n");
}

export interface CreateResult { id: string; filePath: string; fromId: string }

/**
 * 新建策略：复制一份现有策略的**原文**，只改 id 行。
 *
 * 为什么必须从现有的复制、而不是生成一份最小模板：策略 YAML 的每个阈值下面
 * 都有一段注释记着它的由来。生成的空模板会让用户从「不知道这些数该是多少」开始，
 * 而复制出来的第一版至少是个跑得通、且解释得清的基线。
 */
export function createStrategy(id: string, fromId?: string): CreateResult {
  assertSafeId(id);
  const target = strategyPath(id);
  if (fs.existsSync(target)) throw new Error(`策略已存在：${id}`);

  const src = fromId === undefined ? activeStrategyPath() : strategyPath(fromId);
  if (src === null || !fs.existsSync(src)) {
    throw new Error(
      fromId === undefined
        ? "没有可复制的基线策略：先放一份 config/strategies/<id>.yaml"
        : `源策略不存在：${fromId}`
    );
  }
  const text = rewriteIdLine(fs.readFileSync(src, "utf8"), id);
  // 落盘前整份校验：改 id 行理论上不影响其它字段，但"理论上"不该出现在写文件的路径里
  validated(text, target);

  fs.mkdirSync(strategiesDir(), { recursive: true });
  atomicWrite(target, text);
  return { id, filePath: target, fromId: path.basename(src, ".yaml") };
}

/**
 * 删掉策略文件本身，并把原文交还给调用方。
 *
 * 两条拒绝都只和文件状态有关，不需要查库，所以留在这一层：
 *   1. 正在跑的不能删 —— 删掉 active 会让系统下一次读配置直接失败，
 *      而"删了一个策略"和"系统不出信号了"之间的因果对用户并不显然。
 *   2. 最后一个不能删 —— 删完没有任何策略，系统就没有参数了。
 *
 * 返回 raw：ledger 层可能要拿它做快照，而文件删了就再也读不到。
 * 顺序是"先读后删"，不是"先删再想办法找回来"。
 */
export function removeStrategyFile(id: string): { id: string; raw: string; version: string } {
  assertSafeId(id);
  const p = strategyPath(id);
  if (!fs.existsSync(p)) throw new Error(`策略不存在：${id}`);
  if (activeStrategyId() === id) {
    throw new Error(`${id} 正在使用中，先切换到别的策略再删 —— 删掉在用的策略会让系统直接读不出配置`);
  }
  if (listStrategies().filter(s => s.id !== id).length === 0) {
    throw new Error(`${id} 是最后一个策略，删掉系统就没有参数了`);
  }
  const raw = fs.readFileSync(p, "utf8");
  const { version } = validated(raw, p);
  fs.unlinkSync(p);
  return { id, raw, version };
}

/** 读出某个策略的原文与版本，不删。ledger 层做快照用 */
export function readStrategyRaw(id: string): { raw: string; version: string } | null {
  assertSafeId(id);
  const p = strategyPath(id);
  if (!fs.existsSync(p)) return null;
  const raw = fs.readFileSync(p, "utf8");
  try {
    return { raw, version: validated(raw, p).version };
  } catch {
    return null;   // 校验不过的不做快照：快照错了比没有更糟
  }
}

/** 模板后缀。`<id>.yaml.example` 进 git，`<id>.yaml` 是本地实文件、被 gitignore */
export const EXAMPLE_SUFFIX = ".yaml.example";

export interface SeedResult {
  /** 由模板新建出来的策略 id */
  created: string[];
  /** 模板存在但实文件已在，跳过（绝不覆盖用户已有的策略） */
  skipped: string[];
  /** 本次是否顺手写了 ACTIVE 指针，以及指向谁 */
  activeSet: string | null;
}

/**
 * 从 `<id>.yaml.example` 播种出 `<id>.yaml`。
 *
 * 为什么需要它：策略实文件里会出现用户自己的账户 id（`持仓:` 段的键就是账户 id），
 * 那是个人数据，不该进发行源；所以仓库只跟踪去个人化的 `.example`，实文件 gitignore。
 * 代价是新克隆下来一个策略都没有 —— 系统就没有参数可用。这个函数把那一步补上。
 *
 * **显式动作，和 migrateLegacy 同样的道理**：不在读取路径上偷偷生成。
 * 读路径悄悄造出一份配置，会让"我改的 YAML 怎么没生效"变成查不出的问题。
 * 由 `pnpm seed-strategies`（setup.mjs 会调）触发。
 *
 * 已存在的实文件一律跳过、不覆盖、不合并：那是用户攒下来的阈值和注释。
 */
export function seedFromExamples(): SeedResult {
  const dir = strategiesDir();
  const out: SeedResult = { created: [], skipped: [], activeSet: null };
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  for (const f of fs.readdirSync(dir).sort()) {
    if (!f.endsWith(EXAMPLE_SUFFIX)) continue;
    const id = f.slice(0, -EXAMPLE_SUFFIX.length);
    let target: string;
    try {
      target = strategyPath(id);
    } catch {
      continue;   // 模板名不合法当 id 用，跳过而不是抛 —— 一个坏模板不该让播种整体失败
    }
    if (fs.existsSync(target)) {
      out.skipped.push(id);
      continue;
    }
    atomicWrite(target, fs.readFileSync(path.join(dir, f), "utf8"));
    out.created.push(id);
  }
  // 播种后如果还没有指针、而现在正好只有一个策略，把指针写实。
  // 不猜多选一：多个策略却没有指针是"未决"状态，必须让用户自己选（见 activeStrategyId）
  const pointer = path.join(dir, ACTIVE_POINTER);
  if (!fs.existsSync(pointer)) {
    const yamls = fs.readdirSync(dir).filter((f) => f.endsWith(".yaml")).sort();
    if (yamls.length === 1) {
      const id = yamls[0].slice(0, -".yaml".length);
      setActiveStrategy(id);
      out.activeSet = id;
    }
  }
  return out;
}

/**
 * 把老的 config/strategy.yaml 搬进 config/strategies/default.yaml 并写好指针。
 * 显式动作 —— 搬用户的唯一真相源不该在读取路径上偷偷发生。
 */
export function migrateLegacy(): { moved: boolean; from: string; to: string } {
  const from = legacyYamlPath();
  const to = strategyPath("default");
  if (!fs.existsSync(from)) return { moved: false, from, to };
  if (fs.existsSync(to)) return { moved: false, from, to };
  fs.mkdirSync(strategiesDir(), { recursive: true });
  fs.renameSync(from, to);
  setActiveStrategy("default");
  return { moved: true, from, to };
}
