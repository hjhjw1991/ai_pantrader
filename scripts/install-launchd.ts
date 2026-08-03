import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { getConfig } from "@/lib/config";

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
  const argXml = ["/usr/bin/caffeinate", "-i", o.nodeBin, "--import=tsx", o.script, ...o.jobArgs]
    .map(a => `    <string>${a}</string>`).join("\n");

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

/** 盘中 09:35–11:30、13:00–14:55，每 5 分钟一次，避开午休 */
function intradaySlots(): CalEntry[] {
  const out: CalEntry[] = [];
  for (const h of [9, 10, 11, 13, 14]) {
    for (let m = 0; m < 60; m += 5) {
      const t = h * 60 + m;
      if (t < 9 * 60 + 35) continue;
      if (t > 11 * 60 + 30 && t < 13 * 60) continue;
      if (t > 14 * 60 + 55) continue;
      out.push({ Hour: h, Minute: m });
    }
  }
  return out;
}

export const JOB_SCHEDULE: Array<{ label: string; job: string; calendar: CalEntry | CalEntry[] }> = [
  { label: "com.pantrader.selfcheck", job: "selfcheck", calendar: { Hour: 8, Minute: 50 } },
  { label: "com.pantrader.preopen",   job: "preopen",   calendar: { Hour: 9, Minute: 0 } },
  { label: "com.pantrader.intraday",  job: "intraday",  calendar: intradaySlots() },
  { label: "com.pantrader.close",     job: "close",     calendar: { Hour: 15, Minute: 5 } },
  { label: "com.pantrader.post",      job: "post",      calendar: { Hour: 17, Minute: 0 } },
  { label: "com.pantrader.night",     job: "night",     calendar: { Hour: 22, Minute: 0 } },
];

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
