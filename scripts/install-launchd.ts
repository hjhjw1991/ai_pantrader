import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { getConfig } from "@/lib/config";
import { SCHEDULE, awakeWindows } from "@/lib/data/schedule";

export interface CalEntry { Hour?: number; Minute: number }

export interface PlistOpts {
  label: string;
  /** 相对 workdir 的脚本路径，例如 scripts/job.ts */
  script: string;
  /** 传给脚本的参数，原样透传，不加任何前缀 */
  jobArgs: string[];
  calendar: CalEntry | CalEntry[];
  workdir: string;
  logDir: string;
  nodeBin: string;
  /** 直接指定完整命令行，绕过 node/tsx 包装（保持唤醒的 agent 用） */
  argv?: string[];
}

function calXml(c: CalEntry, indent: string): string {
  const parts = [
    c.Hour !== undefined ? `${indent}  <key>Hour</key><integer>${c.Hour}</integer>` : "",
    `${indent}  <key>Minute</key><integer>${c.Minute}</integer>`,
  ].filter(Boolean).join("\n");
  return `${indent}<dict>\n${parts}\n${indent}</dict>`;
}

export function buildPlist(o: PlistOpts): string {
  const cals = Array.isArray(o.calendar) ? o.calendar : [o.calendar];
  const calBlock = cals.length === 1
    ? `  <key>StartCalendarInterval</key>\n${calXml(cals[0], "  ")}`
    : `  <key>StartCalendarInterval</key>\n  <array>\n` +
      cals.map(c => calXml(c, "    ")).join("\n") + `\n  </array>`;

  // caffeinate -i 阻止系统在任务执行期间进入空闲休眠
  const args = o.argv ?? ["/usr/bin/caffeinate", "-i", o.nodeBin, "--import=tsx", o.script, ...o.jobArgs];
  const argXml = args.map(a => `    <string>${a}</string>`).join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${o.label}</string>
  <key>ProgramArguments</key>
  <array>
${argXml}
  </array>
  <key>WorkingDirectory</key>
  <string>${o.workdir}</string>
  <key>StandardOutPath</key>
  <string>${path.join(o.logDir, `${o.label}.out.log`)}</string>
  <key>StandardErrorPath</key>
  <string>${path.join(o.logDir, `${o.label}.err.log`)}</string>
${calBlock}
  <key>RunAtLoad</key>
  <false/>
</dict>
</plist>
`;
}

/** 把共享时刻表的 "HH:MM" 转成 launchd 的 CalEntry。时刻表本身在 lib/data/schedule.ts */
function calOf(slot: string): CalEntry {
  const [h, m] = slot.split(":").map(Number);
  return { Hour: h, Minute: m };
}

/**
 * 保持唤醒。
 *
 * 为什么必须做进系统而不是写在文档里：实测这台机器 `pmset -g custom` 显示
 * AC 与电池都是 `sleep 1` —— 空闲 1 分钟就休眠。而 launchd 的
 * StartCalendarInterval 在休眠期间**不会**按点触发，唤醒后只补跑一次。
 * 全市场快照与分钟线不可回补，睡过去的那一段永久没有。
 *
 * `caffeinate -is`：-i 阻止空闲休眠，-s 在接电源时阻止系统休眠。
 * -t 给足覆盖对应 job 的时长，到点自动退出，不会一直吊着不让机器睡。
 *
 * 仍然管不了的两件事（改代码解决不了，只能告诉用户）：
 *   1. 合盖 —— clamshell 下除非接电源+外接显示器，照样睡
 *   2. 机器关机 —— launchd 不会把关机期间错过的时点补齐
 */
export const KEEPAWAKE_SCHEDULE: Array<{ label: string; calendar: CalEntry; seconds: number }> =
  awakeWindows().map((w) => ({
    // 按时段起点命名，launchctl list 里一眼看出是哪个时段
    label: `com.pantrader.awake.${w.from.replace(":", "")}`,
    calendar: calOf(w.from),
    seconds: w.seconds,
  }));

/**
 * 由共享时刻表推导，不再手写一份。
 * 手写两份的下场是漂移：改了 post 时间只改一处，另一个平台还在旧时点上。
 */
export const JOB_SCHEDULE: Array<{ label: string; job: string; calendar: CalEntry | CalEntry[] }> =
  SCHEDULE.map(j => ({
    label: `com.pantrader.${j.job}`,
    job: j.job,
    calendar: j.slots.length === 1 ? calOf(j.slots[0]) : j.slots.map(calOf),
  }));

// 直接执行时安装；被 import 时（测试）不执行。
// 用文件名判断而非 import.meta.url 全等——tsx 下路径可能经符号链接解析，全等会漏判。
const invokedDirectly = path.basename(process.argv[1] ?? "").startsWith("install-launchd");

if (invokedDirectly) {
  const cfg = getConfig();
  const logDir = path.join(cfg.dataDir, "logs");
  fs.mkdirSync(logDir, { recursive: true });

  const agents = path.join(process.env.HOME!, "Library/LaunchAgents");
  fs.mkdirSync(agents, { recursive: true });
  const workdir = process.cwd();
  const nodeBin = process.execPath;

  for (const k of KEEPAWAKE_SCHEDULE) {
    const xml = buildPlist({
      label: k.label, script: "", jobArgs: [], calendar: k.calendar,
      workdir, logDir, nodeBin,
      argv: ["/usr/bin/caffeinate", "-is", "-t", String(k.seconds)],
    });
    const dest = path.join(agents, `${k.label}.plist`);
    fs.writeFileSync(dest, xml);
    try { execSync(`launchctl unload "${dest}" 2>/dev/null`); } catch { /* 尚未加载 */ }
    execSync(`launchctl load "${dest}"`);
    console.log(`installed ${k.label} (caffeinate ${k.seconds}s)`);
  }

  for (const s of JOB_SCHEDULE) {
    const xml = buildPlist({
      label: s.label, script: "scripts/job.ts", jobArgs: [s.job],
      calendar: s.calendar, workdir, logDir, nodeBin,
    });
    const dest = path.join(agents, `${s.label}.plist`);
    fs.writeFileSync(dest, xml);
    try { execSync(`launchctl unload "${dest}" 2>/dev/null`); } catch { /* 尚未加载 */ }
    execSync(`launchctl load "${dest}"`);
    console.log(`installed ${s.label}`);
  }
  console.log(
    "\nuninstall:\n" +
    "  launchctl unload ~/Library/LaunchAgents/com.pantrader.*.plist\n" +
    "  rm ~/Library/LaunchAgents/com.pantrader.*.plist"
  );
}
