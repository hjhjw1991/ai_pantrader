/**
 * Windows 计划任务安装器（可选的"开机也采"增强）。
 *
 * 与 macOS 的 install-launchd 对称：进程内调度已经能跨平台采集，
 * 这个只解决"系统没跑起来时也照点采集"。时刻表来自 lib/data/schedule.ts，
 * 与 launchd 共用同一份数据 —— 两个平台的时刻表不会漂移。
 *
 * 用 schtasks.exe 而不是 PowerShell 的 ScheduledTasks 模块：
 * schtasks 在所有还在支持的 Windows 上都有，且不需要管理员权限即可建当前用户的任务。
 */
import path from "node:path";
import { execFileSync } from "node:child_process";
import { SCHEDULE } from "@/lib/data/schedule";
import { currentPlatform } from "@/lib/platform/keepawake";
import { getConfig } from "@/lib/config";

export interface TaskDef {
  name: string;
  /** HH:MM，24 小时制 */
  time: string;
  /** schtasks 的 /sc 取值 */
  schedule: "DAILY";
  argv: string[];
  /** 固化进任务的数据目录。不传则沿用默认位置 */
  dataDir?: string;
}

/** 把时刻表摊平成 Windows 计划任务定义。一个时点一个任务 —— schtasks 不支持一任务多时点 */
export function buildTasks(nodeBin: string, workdir: string, dataDir?: string): TaskDef[] {
  const out: TaskDef[] = [];
  for (const j of SCHEDULE) {
    for (const slot of j.slots) {
      out.push({
        name: `PanTrader_${j.job}_${slot.replace(":", "")}`,
        time: slot,
        schedule: "DAILY",
        // 用 path.win32：这些天生是 Windows 路径，在别的宿主上生成任务清单也该是反斜杠
        // --runner=schtasks 与 launchd 侧同理：job.ts 靠它在 job_run 里标明身份
        argv: [
          nodeBin, "--import=tsx", path.win32.join(workdir, "scripts", "job.ts"),
          j.job, "--runner=schtasks",
        ],
        dataDir,
      });
    }
  }
  return out;
}

/**
 * schtasks 命令行。/tr 的命令要整体加引号，路径带空格时必须如此。
 *
 * 带 dataDir 时用 `cmd /c set ... &&` 把数据目录固化进任务本身，而不是指望
 * 计划任务继承用户环境变量。它通常确实会继承（setx 写的是 HKCU\Environment），
 * 但"通常"不够 —— 一旦没继承到，网页用新路径、采集写默认路径，
 * 一份数据分裂成两个库，两边都不报错，等你发现时已经岔开好几天。
 *
 * `set` 后面紧跟 `&&` 不留空格：`set X=a && ...` 会把结尾空格算进变量值，
 * 于是路径末尾多一个空格，目录就找不到了。
 */
export function schtasksArgs(t: TaskDef): string[] {
  const cmd = t.argv.map(a => (a.includes(" ") ? `\\"${a}\\"` : a)).join(" ");
  const tr = t.dataDir === undefined
    ? `"${cmd}"`
    : `"cmd /c set PANTRADER_DATA_DIR=${t.dataDir}&& ${cmd}"`;
  return [
    "/Create", "/F",
    "/TN", t.name,
    "/SC", t.schedule,
    "/ST", t.time,
    "/TR", tr,
  ];
}

const invokedDirectly = path.basename(process.argv[1] ?? "").startsWith("install-schtasks");

if (invokedDirectly) {
  if (currentPlatform() !== "win32") {
    console.error(
      `当前平台是 ${process.platform}，不是 Windows。\n` +
      `macOS 用 \`pnpm install-launchd\`；\n` +
      `任何平台都可以直接 \`pnpm daemon\`（进程内调度，无需注册系统任务）。`
    );
    process.exit(2);
  }
  const tasks = buildTasks(process.execPath, process.cwd(), getConfig().dataDir);
  for (const t of tasks) {
    execFileSync("schtasks.exe", schtasksArgs(t), { stdio: "inherit", shell: true });
  }
  console.log(`\n已安装 ${tasks.length} 个计划任务。`);
  console.log(`卸载：schtasks /Delete /F /TN "PanTrader_*"`);
  console.log(`注意：Windows 睡眠时计划任务默认不唤醒机器 —— 采集时段请让机器保持唤醒。`);
}
