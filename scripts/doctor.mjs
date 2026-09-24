#!/usr/bin/env node
/**
 * 环境体检。**只读，不改任何东西。**
 *
 * 纯 .mjs、不 import 项目里的任何模块 —— 和 setup.mjs 同一个理由：
 * 它要在依赖装好之前、甚至在依赖装坏了之后仍然能跑。
 * 一个需要先 `pnpm install` 成功才能告诉你"为什么 pnpm install 失败"的诊断工具没有意义。
 *
 * 与 `setup.mjs --check` 的分工：
 *   setup --check  安装前的**闸门**：只看"能不能往下装"，不通过就退出码 1
 *   doctor         摊开的**体检**：把每一项的现状、是否必需、缺了怎么补都列出来，
 *                  包括 setup 不关心的（工具链、磁盘、定时任务指向的 Node 还在不在）
 *
 * 退出码：0 = 没有阻塞项（可能仍有告警）；1 = 有阻塞项。
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync, statfsSync } from "node:fs";
import { homedir, platform, arch, totalmem } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OS = platform();
const IS_WIN = OS === "win32";

const C = process.stdout.isTTY
  ? { dim: "\x1b[2m", red: "\x1b[31m", green: "\x1b[32m", yellow: "\x1b[33m", cyan: "\x1b[36m", bold: "\x1b[1m", off: "\x1b[0m" }
  : { dim: "", red: "", green: "", yellow: "", cyan: "", bold: "", off: "" };

/**
 * 三种结论，语义**必须**分开：
 *   ok    合格
 *   warn  缺了但不挡路（少个功能 / 只是建议）
 *   fail  阻塞，装不上或跑不起来
 * 把 warn 和 fail 混成一种颜色，人就会开始忽略所有颜色。
 */
const results = [];
const ok = (name, detail) => results.push({ level: "ok", name, detail });
const warn = (name, detail, fix) => results.push({ level: "warn", name, detail, fix });
const fail = (name, detail, fix) => results.push({ level: "fail", name, detail, fix });

function sh(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: "utf8", shell: IS_WIN, ...opts });
  return { ok: r.status === 0, out: `${r.stdout ?? ""}${r.stderr ?? ""}`.trim(), status: r.status };
}
function has(cmd) {
  return spawnSync(IS_WIN ? "where" : "which", [cmd], { stdio: "ignore", shell: IS_WIN }).status === 0;
}
const firstLine = (s) => s.split("\n")[0].trim();

// ────────────────────────────── Node ──────────────────────────────

const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"));
const ENGINE = pkg.engines?.node ?? ">=22";
const MIN = Number(/>=\s*(\d+)/.exec(ENGINE)?.[1] ?? 22);
const MAX_EX = Number(/<\s*(\d+)/.exec(ENGINE)?.[1] ?? Number.POSITIVE_INFINITY);
const major = Number(process.versions.node.split(".")[0]);
const ABI = process.versions.modules;

if (major < MIN) {
  fail("Node 版本", `当前 ${process.versions.node}，需要 ${ENGINE}`,
    `nvm install ${MIN} && nvm use ${MIN}（仓库根目录有 .nvmrc）`);
} else if (major >= MAX_EX) {
  fail("Node 版本", `当前 ${process.versions.node} 超出上界，需要 ${ENGINE}`,
    `nvm use ${MIN}`);
} else {
  ok("Node 版本", `${process.versions.node}（ABI ${ABI}，engines ${ENGINE}）`);
}
ok("平台", `${OS} ${arch()}　内存 ${(totalmem() / 1024 ** 3).toFixed(1)} GB`);

/**
 * 版本行是给 bug 报告用的：issue 模板让人把本段输出整段贴上来，
 * 没有版本号与 commit，维护者拿到报告的第一件事仍然是回头问"你哪个版本"。
 * git 可能没装、或者用户是下载 zip 解压的（没有 .git），那两种情况下
 * 只报 package.json 的版本，不报错 —— 体检不该因为拿不到 commit 就变红。
 */
{
  const git = sh("git", ["-C", ROOT, "rev-parse", "--short", "HEAD"]);
  const dirty = git.ok && sh("git", ["-C", ROOT, "status", "--porcelain"]).out !== "";
  const rev = git.ok ? `${firstLine(git.out)}${dirty ? "-dirty" : ""}` : "非 git 检出";
  ok("版本", `${pkg.name} ${pkg.version}　${rev}`);
}

// ───────────────────────────── 包管理器 ─────────────────────────────

if (has("pnpm")) {
  ok("包管理器", `pnpm ${firstLine(sh("pnpm", ["-v"]).out) || "?"}`);
} else if (has("npm")) {
  warn("包管理器", "只有 npm，没有 pnpm",
    "仓库带 pnpm-lock.yaml，npm 会忽略锁文件里的确定版本 → npm i -g pnpm");
} else {
  fail("包管理器", "pnpm 和 npm 都找不到", "Node 自带 npm；若确实没有，重装 Node");
}

// ─────────────────── 原生模块：先看装没装得上，再谈要不要工具链 ───────────────────

/**
 * 判断顺序很重要：**先真加载一次**。
 *
 * 只要 better-sqlite3 能加载，工具链就一概不需要 —— 无论它是预编译还是早先编好的。
 * 反过来先查工具链，就会对着一台完全健康的机器喊"你没装 Xcode"，
 * 而那台机器根本不需要编译。这是这类 doctor 最常见的假阳性。
 */
const bsDir = path.join(ROOT, "node_modules", "better-sqlite3");
let nativeLoads = false;
let needsToolchain = null;          // null = 还判断不了

if (!existsSync(bsDir)) {
  warn("better-sqlite3", "依赖还没装", "pnpm install（或 node scripts/setup.mjs）");
} else {
  const probe = sh(process.execPath, ["-e", "require('better-sqlite3')"], { cwd: ROOT });
  if (probe.ok) {
    nativeLoads = true;
    let ver = "?";
    try { ver = JSON.parse(readFileSync(path.join(bsDir, "package.json"), "utf8")).version; } catch { /* 版本读不到不影响结论 */ }
    // N-API 的产物按平台分（darwin-arm64.node），旧的 prebuild-install 按 ABI 分（build/Release/*.node）
    const napi = existsSync(path.join(bsDir, "prebuilds")) || existsSync(path.join(bsDir, "build", "darwin-arm64.node"));
    ok("better-sqlite3", `${ver} 可装载${napi ? "（N-API，换 Node 大版本不用重编）" : "（绑 ABI，换 Node 大版本要重装/重编）"}`);
    needsToolchain = false;
  } else {
    const abi = /NODE_MODULE_VERSION (\d+)[\s\S]*?NODE_MODULE_VERSION (\d+)/.exec(probe.out);
    fail("better-sqlite3",
      abi ? `装载失败：.node 编译于 ABI ${abi[1]}，当前 Node 要 ABI ${abi[2]}` : `装载失败：${firstLine(probe.out)}`,
      abi ? `换回匹配的 Node，或 pnpm rebuild better-sqlite3` : "pnpm install");
    needsToolchain = true;          // 要重编，就真需要工具链了
  }
}

// ───────────────────────────── C++ 工具链 ─────────────────────────────

/**
 * 按平台查，而且**把"当前需不需要"一起说清楚**。
 *
 * 光说"你缺 Xcode CLT"是没用的信息：用户会去装一个 1.5 GB 的东西，
 * 而他可能根本用不上（有预编译包时一次都不会调用编译器）。
 * 所以缺工具链在"原生模块已经能加载"时只记 warn，并明说它是给什么场景兜底的。
 */
function checkToolchain() {
  const level = needsToolchain === false ? warn : fail;
  const whyOptional = needsToolchain === false
    ? "当前用不上（原生模块已能直接加载），只有将来需要从源码编译时才要"
    : "当前需要它：原生模块没有可用的预编译产物，得现场编译";

  if (OS === "darwin") {
    const clt = sh("xcode-select", ["-p"]);
    const clang = has("clang") ? firstLine(sh("clang", ["--version"]).out) : null;
    if (clt.ok && clang) {
      ok("C++ 工具链", `Xcode CLT ${clt.out}　${clang}`);
    } else {
      level("C++ 工具链", `未检出 Xcode Command Line Tools —— ${whyOptional}`,
        "xcode-select --install");
    }
    return;
  }

  if (IS_WIN) {
    // vswhere 是 VS 官方的定位工具，装了任意 VS/BuildTools 就有它，路径是固定的
    const vswhere = path.join(
      process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)",
      "Microsoft Visual Studio", "Installer", "vswhere.exe"
    );
    let found = null;
    if (existsSync(vswhere)) {
      const r = sh(vswhere, ["-latest", "-products", "*",
        "-requires", "Microsoft.VisualStudio.Component.VC.Tools.x86.x64",
        "-property", "displayName"]);
      if (r.ok && r.out) found = firstLine(r.out);
    }
    if (found) {
      ok("C++ 工具链", `${found}（含 VC++ 生成工具）`);
    } else if (has("cl")) {
      ok("C++ 工具链", "cl.exe 在 PATH 上（多半是在 Developer Command Prompt 里跑的）");
    } else {
      level("C++ 工具链", `未检出 Visual Studio C++ 生成工具 —— ${whyOptional}`,
        "装 Visual Studio Build Tools 并勾选「使用 C++ 的桌面开发」工作负载：\n" +
        "      https://visualstudio.microsoft.com/visual-cpp-build-tools/");
    }
    return;
  }

  // linux 及其它 unix
  const cc = has("cc") || has("gcc");
  const cxx = has("c++") || has("g++");
  const make = has("make");
  const py = has("python3") || has("python");
  const miss = [!cc && "gcc", !cxx && "g++", !make && "make", !py && "python3"].filter(Boolean);
  if (miss.length === 0) {
    ok("C++ 工具链", `${firstLine(sh(has("gcc") ? "gcc" : "cc", ["--version"]).out)}　make/python3 齐备`);
  } else {
    level("C++ 工具链", `缺 ${miss.join(" / ")} —— ${whyOptional}`,
      "Debian/Ubuntu: sudo apt install build-essential python3\n" +
      "      Fedora/RHEL:   sudo dnf install gcc-c++ make python3\n" +
      "      Alpine:        sudo apk add build-base python3");
  }
}
checkToolchain();

// ───────────────────────────── 数据目录 ─────────────────────────────

const dataDir = process.env.PANTRADER_DATA_DIR ?? path.join(homedir(), "PanTraderData");
if (!existsSync(dataDir)) {
  warn("数据目录", `${dataDir} 还不存在`, "首次 migrate 会建；或先跑 node scripts/setup.mjs");
} else {
  let detail = dataDir;
  const db = path.join(dataDir, "pantrader.db");
  if (existsSync(db)) {
    // WAL 单独算：它能长到几百 MB，而那通常意味着 checkpoint 没跟上，值得看见
    const wal = `${db}-wal`;
    const gb = (f) => { try { return statSync(f).size / 1024 ** 3; } catch { return 0; } };
    detail += `　库 ${gb(db).toFixed(2)} GB`;
    if (existsSync(wal)) detail += ` + WAL ${(gb(wal) * 1024).toFixed(0)} MB`;
  }
  ok("数据目录", detail);

  /**
   * 磁盘余量单列一项：这个库只会变大（全量日线每天 +900 条/只，快照按分钟累积）。
   * 盘中写不进去不会有醒目的报错，只会变成一条"采集失败"淹在日志里。
   */
  try {
    const st = statfsSync(dataDir);
    const freeGb = (st.bavail * st.bsize) / 1024 ** 3;
    if (freeGb < 5) {
      fail("磁盘余量", `${freeGb.toFixed(1)} GB 可用 —— 库只会变大，盘中写失败只会淹在日志里`,
        "清一下盘，或用 PANTRADER_DATA_DIR 把数据目录挪到大盘上");
    } else if (freeGb < 20) {
      warn("磁盘余量", `${freeGb.toFixed(1)} GB 可用`, "全量日线 + 分钟快照会持续增长，建议留 20 GB 以上");
    } else {
      ok("磁盘余量", `${freeGb.toFixed(1)} GB 可用`);
    }
  } catch {
    warn("磁盘余量", "查不到（statfs 不可用）", "手动确认数据盘还有空间");
  }
}

// ───────────────────────────── 策略文件 ─────────────────────────────

{
  const sdir = path.join(ROOT, "config", "strategies");
  const files = existsSync(sdir) ? readdirSync(sdir) : [];
  const real = files.filter((f) => f.endsWith(".yaml"));
  const tpl = files.filter((f) => f.endsWith(".yaml.example"));
  if (real.length > 0) ok("策略文件", `实文件 ${real.length} 个（模板 ${tpl.length} 个）`);
  else if (tpl.length > 0) warn("策略文件", "只有模板没有实文件 —— 策略层拿不到任何参数", "pnpm run seed-strategies");
  else fail("策略文件", "config/strategies 下既无实文件也无模板", "检查仓库是否完整 clone");
}

// ──────────────────── 旧版定时任务残留 ────────────────────

/**
 * 调度只靠进程内调度（启动网页服务或 pnpm daemon 时自动拉起），不再往操作系统里装定时任务 ——
 * 那种任务换一台电脑不会跟着走，还会把安装当时那个 Node 的绝对路径写死。
 *
 * 装过旧版本的机器上可能还留着 launchd / schtasks 任务：它们会在系统没开时自己跑、
 * 指向的解释器也可能早就不在了。发现了就提示删掉。
 */
function checkLegacyScheduled() {
  if (OS === "darwin") {
    const dir = path.join(homedir(), "Library", "LaunchAgents");
    const plists = existsSync(dir) ? readdirSync(dir).filter((f) => f.startsWith("com.pantrader.")) : [];
    if (plists.length === 0) ok("旧版定时任务", "无残留（调度只靠进程内守护进程）");
    else warn("旧版定时任务", `发现 ${plists.length} 个旧 launchd 任务（${dir}）`,
      "系统已不再使用它们：for f in ~/Library/LaunchAgents/com.pantrader.*.plist; do launchctl bootout gui/$(id -u)/$(basename $f .plist); rm $f; done");
    return;
  }
  if (IS_WIN) {
    const r = sh("schtasks", ["/query", "/fo", "list", "/v"]);
    const n = r.ok ? (r.out.match(/PanTrader/g) ?? []).length : 0;
    if (n === 0) ok("旧版定时任务", "无残留（调度只靠进程内守护进程）");
    else warn("旧版定时任务", `schtasks 里有 ${n} 条旧 PanTrader 记录`, `系统已不再使用它们：schtasks /Delete /F /TN "PanTrader_*"`);
  }
}
checkLegacyScheduled();

// ───────────────────────────── 输出 ─────────────────────────────

const icon = { ok: `${C.green}✓${C.off}`, warn: `${C.yellow}!${C.off}`, fail: `${C.red}✗${C.off}` };

/** 中日韩字符占两列，用 length 对齐会歪。只区分宽/窄两档，够这里用 */
const width = (s) => [...s].reduce((n, ch) => n + (/[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6]/.test(ch) ? 2 : 1), 0);
const NAME_COLS = Math.max(...results.map((r) => width(r.name)));
const pad = (s) => s + " ".repeat(NAME_COLS - width(s));

console.log(`\n${C.bold}候潮 环境体检${C.off}　${C.dim}只读，不会改任何东西${C.off}\n`);
for (const r of results) {
  console.log(`  ${icon[r.level]} ${pad(r.name)}  ${r.detail}`);
  if (r.fix) console.log(`      ${C.cyan}→ ${r.fix}${C.off}`);
}

const fails = results.filter((r) => r.level === "fail");
const warns = results.filter((r) => r.level === "warn");
console.log();
if (fails.length > 0) {
  console.log(`${C.red}${fails.length} 项阻塞${C.off}${warns.length ? `，${warns.length} 项告警` : ""}　—— 上面每条都带了修法`);
  process.exit(1);
}
if (warns.length > 0) {
  console.log(`${C.green}没有阻塞项${C.off}，${C.yellow}${warns.length} 项告警${C.off}　—— 告警不挡运行，按需处理`);
} else {
  console.log(`${C.green}全部通过。${C.off}`);
}
