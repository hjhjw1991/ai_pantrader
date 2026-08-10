#!/usr/bin/env node
/**
 * 一键安装并启动。**纯 .mjs，不用 tsx** ——
 * 这个脚本要在依赖装好之前就能跑，而 tsx 本身是依赖之一。
 * 同理不 import 项目里的任何模块（那些都是 TS）。
 *
 * 平台无关：只用 node 内置 + spawnSync，不写 .sh / .ps1 两份 ——
 * 两份脚本必然漂移，而漂移的那一份只在另一个平台上炸，本机永远发现不了。
 *
 * 用法：
 *   node scripts/setup.mjs              装依赖 → 建库 → 灌基础数据 → 构建
 *   node scripts/setup.mjs --start      上面全做完再启动网页
 *   node scripts/setup.mjs --no-data    跳过灌数据（不打网络，适合先看界面）
 *   node scripts/setup.mjs --dev        用开发模式启动（热更新，不预构建）
 *   node scripts/setup.mjs --check      只检查环境，什么都不改
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { homedir, platform } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const argv = new Set(process.argv.slice(2));
const flag = (n) => argv.has(n);

const C = process.stdout.isTTY
  ? { dim: "\x1b[2m", red: "\x1b[31m", green: "\x1b[32m", yellow: "\x1b[33m", bold: "\x1b[1m", off: "\x1b[0m" }
  : { dim: "", red: "", green: "", yellow: "", bold: "", off: "" };

let step = 0;
const say = (m) => console.log(`\n${C.bold}[${++step}] ${m}${C.off}`);
const info = (m) => console.log(`    ${C.dim}${m}${C.off}`);
const ok = (m) => console.log(`    ${C.green}✓${C.off} ${m}`);
const warn = (m) => console.log(`    ${C.yellow}!${C.off} ${m}`);
const die = (m, hint) => {
  console.error(`\n${C.red}✗ ${m}${C.off}`);
  if (hint) console.error(`  ${hint}`);
  process.exit(1);
};

/** 同步跑一条命令，输出直接透传（安装过程要能看见进度，不能憋着） */
function run(cmd, args, opts = {}) {
  info(`$ ${cmd} ${args.join(" ")}`);
  const r = spawnSync(cmd, args, {
    cwd: ROOT, stdio: "inherit", shell: platform() === "win32", ...opts,
  });
  if (r.error) die(`${cmd} 执行失败：${r.error.message}`);
  if (r.status !== 0) die(`${cmd} 退出码 ${r.status}`);
}

function has(cmd) {
  const probe = platform() === "win32" ? "where" : "which";
  return spawnSync(probe, [cmd], { stdio: "ignore", shell: platform() === "win32" }).status === 0;
}

// ─────────────────────────── 1. 环境 ───────────────────────────

say("检查运行环境");

/**
 * Node 版本要**上下都卡**，不只是"够新"。
 *
 * 上界的理由是原生模块：better-sqlite3 的预编译 .node 绑定 NODE_MODULE_VERSION，
 * 换了 Node 大版本就 dlopen 失败；而 install-launchd / install-schtasks 写进
 * 计划任务的解释器路径，是**安装当时那个 Node 的绝对路径**。所以这个项目实际是
 * "按某个 Node 大版本部署"的，允许更高版本只会让采集与网页跑在两个 ABI 上。
 *
 * 解析要按 semver 区间取字段，别用 replace(/[^\d]/g,"") ——
 * ">=22 <23" 会被那种写法拼成 2223。
 */
const major = Number(process.versions.node.split(".")[0]);
const ENGINE = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")).engines?.node ?? ">=22 <23";
const MIN = Number(/>=\s*(\d+)/.exec(ENGINE)?.[1] ?? 22);
const MAX_EX = Number(/<\s*(\d+)/.exec(ENGINE)?.[1] ?? Number.POSITIVE_INFINITY);
if (Number.isNaN(major) || major < MIN) {
  die(
    `Node 版本过低：当前 ${process.versions.node}，需要 ${ENGINE}`,
    `装对版本：nvm install ${MIN} && nvm use ${MIN}（仓库根目录有 .nvmrc，nvm use 会自动读）`
  );
}
if (major >= MAX_EX) {
  die(
    `Node 版本过高：当前 ${process.versions.node}，本项目按 Node ${MIN} 部署（engines: ${ENGINE}）`,
    `原生模块 better-sqlite3 的预编译包绑 Node ABI，计划任务里也写死了安装时的 Node 路径。\n  ` +
      `执行 nvm use ${MIN} 再重跑本脚本。`
  );
}
ok(`Node ${process.versions.node}（engines ${ENGINE}）`);
ok(`平台 ${platform()} ${process.arch}`);

// pnpm 优先：仓库带 pnpm-lock.yaml，用 npm 装会忽略 lock 里的确定版本
const PM = has("pnpm") ? "pnpm" : has("npm") ? "npm" : null;
if (PM === null) die("找不到 pnpm 也找不到 npm", "Node 自带 npm；若确实没有，重装 Node");
if (PM === "npm") {
  warn("没装 pnpm，改用 npm。仓库有 pnpm-lock.yaml，用 npm 装到的版本可能与锁文件不一致");
  info("装 pnpm：npm i -g pnpm");
} else {
  ok("pnpm 可用");
}

// better-sqlite3 是原生模块。有预编译包就不用编译器；没有才需要工具链
if (platform() === "win32") {
  info("Windows 上 better-sqlite3 若无预编译包，需要 VS Build Tools（C++ 桌面开发）");
}

/**
 * 真装载一次 better-sqlite3。
 *
 * 版本号在区间里 ≠ .node 装得上：同一个大版本内换 Node、跨机拷 node_modules、
 * 装完之后升级 Node，都会留下一个 ABI 不匹配的 .node。这种故障在业务代码里
 * 表现为"连不上数据库"，离真正的原因隔了好几层，只有在这里探一次才便宜。
 */
function probeNative({ required }) {
  if (!existsSync(path.join(ROOT, "node_modules", "better-sqlite3"))) {
    if (required) die("装完依赖后仍找不到 node_modules/better-sqlite3", `重跑 ${PM} install`);
    info("node_modules/better-sqlite3 还没装，装完依赖后再探测");
    return;
  }
  const probe = spawnSync(process.execPath, ["-e", "require('better-sqlite3')"], {
    cwd: ROOT, encoding: "utf8",
  });
  if (probe.status === 0) {
    ok("better-sqlite3 原生模块可装载");
    return;
  }
  const msg = `${probe.stderr ?? ""}`.trim();
  const abi = /NODE_MODULE_VERSION (\d+)[\s\S]*?NODE_MODULE_VERSION (\d+)/.exec(msg);
  die(
    `better-sqlite3 原生模块装载失败${abi ? `：.node 编译于 ABI ${abi[1]}，当前 Node 要 ABI ${abi[2]}` : ""}`,
    abi
      ? `换回匹配的 Node（nvm use ${MIN}），或就地重编：${PM} rebuild better-sqlite3\n  ` +
        `注意：重编成新 ABI 之后，计划任务里写死的旧 Node 会反过来跑不动 —— 采集和网页必须同一个 Node。`
      : `原始报错：\n  ${msg.split("\n").slice(0, 6).join("\n  ")}`
  );
}
// --check 只读不改，就在这里探一次；完整安装则等 install 之后探（install 本身可能就把它修好了）
if (flag("--check")) probeNative({ required: false });

const dataDir = process.env.PANTRADER_DATA_DIR ?? path.join(homedir(), "PanTraderData");
ok(`数据目录 ${dataDir}`);
info("数据库刻意放在仓库之外：免费数据源随时会封，攒下的历史是不可再生资产，");
info("必须能独立备份、且不会被 git clean / 重装项目连带删掉。");

// 策略实文件在不在。--check 只报不改，所以这里不播种，只说清现状与补法
{
  const sdir = path.join(ROOT, "config", "strategies");
  const files = existsSync(sdir) ? readdirSync(sdir) : [];
  const real = files.filter((f) => f.endsWith(".yaml"));
  const examples = files.filter((f) => f.endsWith(".yaml.example"));
  if (real.length > 0) {
    ok(`策略实文件 ${real.length} 个（模板 ${examples.length} 个）`);
  } else if (examples.length > 0) {
    warn(`只有模板没有实文件 —— 系统没有参数可用。跑：${PM} run seed-strategies`);
  } else {
    warn("config/strategies 下既无实文件也无模板，策略层拿不到任何配置");
  }
}

if (flag("--check")) {
  console.log(`\n${C.green}环境检查通过，未做任何修改。${C.off}`);
  process.exit(0);
}

// ─────────────────────────── 2. 依赖 ───────────────────────────

say("安装依赖");
if (existsSync(path.join(ROOT, "node_modules"))) {
  info("node_modules 已存在，仍执行一次以对齐锁文件");
}
run(PM, PM === "pnpm" ? ["install"] : ["install"]);
ok("依赖就绪");
// 装完立刻验原生模块：后面每一步（migrate/bootstrap/build）都要开库，在这里拦住最省事
probeNative({ required: true });

// ─────────────────────────── 3. 数据库 ───────────────────────────

say("建库与迁移");
mkdirSync(dataDir, { recursive: true });
run(PM, ["run", "migrate"]);
ok("schema 已是最新");

// ────────────────────── 3.5 策略实文件 ──────────────────────

/**
 * 策略实文件不进 git（`持仓:` 段的键是用户自己的账户 id = 个人数据），
 * 仓库只带 `config/strategies/*.yaml.example`。新克隆下来一个策略都没有，
 * 而没有策略 = 系统没有参数，所以这一步必须在装完就跑。
 *
 * 幂等：已存在的实文件一律跳过不覆盖，重跑 setup 不会动你改过的阈值。
 */
say("播种策略实文件");
info("模板 config/strategies/*.yaml.example 进 git；实文件不进，因为里面有你的账户 id");
run(PM, ["run", "seed-strategies"]);
ok("策略就绪");

// ─────────────────────────── 4. 基础数据 ───────────────────────────

if (flag("--no-data")) {
  say("跳过基础数据（--no-data）");
  warn("证券清单与交易日历为空，页面会显示空态而不是编造数字");
  info("想补的时候跑：" + PM + " run bootstrap");
} else {
  say("灌基础数据（会打网络，约 1–3 分钟）");
  info("拉 5000+ 只证券清单 + 近三年交易日历。可以随时 Ctrl-C，重跑会自动续拉。");
  info("数据源是免费非官方接口，会限频；脚本自带退避与多源降级。");
  run(PM, ["run", "bootstrap"]);
  ok("基础数据就绪");
}

// ─────────────────────────── 5. 构建 / 启动 ───────────────────────────

const PORT = process.env.PORT ?? "3111";

if (flag("--dev")) {
  say(`开发模式启动 → http://localhost:${PORT}`);
  info("开发模式带热更新，改代码即时生效，但比生产模式慢。Ctrl-C 停止。");
  run(PM, ["run", "dev"]);
} else {
  say("构建生产包");
  run(PM, ["run", "build"]);
  ok("构建完成");

  if (flag("--start")) {
    say(`启动 → http://localhost:${PORT}`);
    info("首次打开建议先去 /settings 看数据源健康与缺口，再去 /positions 建账户。");
    run(PM, ["run", "start"]);
  } else {
    console.log(`
${C.green}${C.bold}装好了。${C.off}

启动网页：
  ${C.bold}${PM} start${C.off}                 → http://localhost:${PORT}

后台采集（可选，与网页独立进程）：
  ${C.bold}${PM} run daemon${C.off}

下一步：
  1. 打开 http://localhost:${PORT}/settings   看数据源健康、缺口、当前策略
  2. 打开 http://localhost:${PORT}/positions  建自己的账户（系统不预置任何账户）
  3. 把 ${C.bold}持仓${C.off} 段的键名改成你的账户 id
     —— 在 /settings 的「策略原文编辑」里改（自动备份 + 校验），或直接编辑
        config/strategies/default.yaml（该文件不进 git，模板是同名 .yaml.example）
     —— 键名对不上，那个账户就没有止损规则（持仓页会红字点名，不会静默失效）

${C.yellow}这套系统不会自动下单。${C.off}下单在券商 App 手敲，回来在持仓页回填成交。
`);
  }
}
