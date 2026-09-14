import { describe, it, expect } from "vitest";
import { buildPlist, JOB_SCHEDULE, KEEPAWAKE_SCHEDULE } from "@/scripts/install-launchd";
import { buildTasks, schtasksArgs } from "@/scripts/install-schtasks";
import { allSlots } from "@/lib/data/schedule";

describe("buildPlist", () => {
  const plist = buildPlist({
    label: "com.pantrader.close",
    script: "scripts/job.ts",
    jobArgs: ["close"],
    calendar: { Hour: 15, Minute: 5 },
    workdir: "/Users/x/workspace/pantrader",
    logDir: "/Users/x/PanTraderData/logs",
    nodeBin: "/usr/local/bin/node",
  });

  it("是合法 plist 且含 Label", () => {
    expect(plist).toContain("<!DOCTYPE plist");
    expect(plist).toContain("<string>com.pantrader.close</string>");
  });

  it("用 caffeinate 包住命令防休眠", () => {
    expect(plist).toContain("/usr/bin/caffeinate");
  });

  it("写入 StartCalendarInterval", () => {
    expect(plist).toContain("StartCalendarInterval");
    expect(plist).toContain("<key>Hour</key>");
    expect(plist).toContain("<integer>15</integer>");
  });

  it("stdout/stderr 落到日志目录", () => {
    expect(plist).toContain("/Users/x/PanTraderData/logs/com.pantrader.close.out.log");
    expect(plist).toContain("/Users/x/PanTraderData/logs/com.pantrader.close.err.log");
  });

  it("脚本路径只出现一次，job 参数不被加前缀", () => {
    expect(plist).toContain("<string>scripts/job.ts</string>");
    expect(plist).toContain("<string>close</string>");
    expect(plist).not.toContain("<string>scripts/close</string>");
  });

  it("多时点用 array 包裹", () => {
    const multi = buildPlist({
      label: "com.pantrader.intraday",
      script: "scripts/job.ts",
      jobArgs: ["intraday"],
      calendar: [{ Hour: 9, Minute: 35 }, { Hour: 10, Minute: 0 }],
      workdir: "/w", logDir: "/l", nodeBin: "/n",
    });
    expect(multi).toContain("<array>");
    expect(multi).toContain("<integer>35</integer>");
  });
});

describe("JOB_SCHEDULE", () => {
  it("覆盖 spec 定义的全部时段", () => {
    const jobs = JOB_SCHEDULE.map(j => j.job);
    for (const j of ["selfcheck", "preopen", "intraday", "close", "post", "night"]) {
      expect(jobs).toContain(j);
    }
  });

  it("盘中任务覆盖上下午，且避开午休与非交易时段", () => {
    const intraday = JOB_SCHEDULE.filter(j => j.job === "intraday");
    const cals = intraday.flatMap(j => Array.isArray(j.calendar) ? j.calendar : [j.calendar]);
    const hours = new Set(cals.map((c: any) => c.Hour));
    expect(hours.has(9)).toBe(true);
    expect(hours.has(14)).toBe(true);
    expect(hours.has(12)).toBe(false);   // 午休不跑
    expect(hours.has(16)).toBe(false);   // 收盘后不跑
  });

  it("盘中不早于 09:35，不晚于 14:55", () => {
    const intraday = JOB_SCHEDULE.filter(j => j.job === "intraday");
    const cals = intraday.flatMap(j => Array.isArray(j.calendar) ? j.calendar : [j.calendar]) as any[];
    for (const c of cals) {
      const t = c.Hour * 60 + c.Minute;
      expect(t).toBeGreaterThanOrEqual(9 * 60 + 35);
      expect(t).toBeLessThanOrEqual(14 * 60 + 55);
      // 11:30 之后到 13:00 之前不应有任务
      expect(t > 11 * 60 + 30 && t < 13 * 60).toBe(false);
    }
  });

  it("每个 label 唯一", () => {
    const labels = JOB_SCHEDULE.map(j => j.label);
    expect(new Set(labels).size).toBe(labels.length);
  });
});

describe("保持唤醒 agent", () => {
  /** 断言"覆盖性"而不是标签名：名字会变，覆盖不到才是真问题 */
  const covers = (hm: number) => KEEPAWAKE_SCHEDULE.some(k => {
    const start = (k.calendar.Hour ?? 0) * 60 + k.calendar.Minute;
    return hm >= start && hm <= start + k.seconds / 60;
  });

  it("每一个 job 时点都被某个防休眠时段覆盖", () => {
    for (const { slot } of allSlots()) {
      const [h, m] = slot.split(":").map(Number);
      expect(covers(h * 60 + m), `${slot} 未被防休眠覆盖`).toBe(true);
    }
  });

  it("盘中首尾与收盘都在覆盖内", () => {
    expect(covers(9 * 60 + 35)).toBe(true);
    expect(covers(14 * 60 + 55)).toBe(true);
    expect(covers(15 * 60 + 5)).toBe(true);
  });

  it("用 -t 限时，不会一直吊着不让机器睡", () => {
    for (const k of KEEPAWAKE_SCHEDULE) {
      const xml = buildPlist({
        label: k.label, script: "", jobArgs: [], calendar: k.calendar,
        workdir: "/w", logDir: "/l", nodeBin: "/n",
        argv: ["/usr/bin/caffeinate", "-is", "-t", String(k.seconds)],
      });
      expect(xml).toContain("<string>-t</string>");
      expect(xml).toContain(`<string>${k.seconds}</string>`);
      // 不能是无限期 caffeinate
      expect(k.seconds).toBeLessThan(9 * 3600);
    }
  });

  it("夜间时段要盖住全量日线（实测约 30 分钟）", () => {
    // 22:00 起跑，跑到 22:30 左右，覆盖必须延续到 22:35 之后
    expect(covers(22 * 60)).toBe(true);
    expect(covers(22 * 60 + 35)).toBe(true);
  });
});

describe("Windows 计划任务安装器", () => {
  it("时刻表与 launchd 共用同一份数据，两平台不会漂移", () => {
    const tasks = buildTasks("C:\\node.exe", "C:\\pantrader");
    const winSlots = tasks.map(t => t.time).sort();
    const shared = allSlots().map(s => s.slot).sort();
    expect(winSlots).toEqual(shared);
  });

  it("每个任务名唯一 —— schtasks 一个任务只能一个时点", () => {
    const names = buildTasks("node", "/w").map(t => t.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("带空格的路径要加引号，否则 schtasks 会截断命令", () => {
    const t = buildTasks("C:\\Program Files\\node.exe", "C:\\My Projects\\pantrader")[0];
    const args = schtasksArgs(t);
    const tr = args[args.indexOf("/TR") + 1];
    expect(tr.startsWith('"')).toBe(true);
    expect(tr).toContain(String.raw`\"C:\Program Files\node.exe\"`);
    // 工作目录也带空格，同样要被引起来
    expect(tr).toContain(String.raw`\"C:\My Projects\pantrader\scripts\job.ts\"`);
  });
});

/**
 * launchd 不继承 shell 环境变量 —— 它由 launchd 直接拉起，看不到 .zshrc 里的 export。
 * 所以数据目录必须固化进 plist。不固化的后果是静默的：网页和 daemon 用
 * PANTRADER_DATA_DIR 指的新路径，定时采集写回默认路径，一份数据分裂成两个库。
 */
describe("plist 里的数据目录", () => {
  const base = {
    label: "com.pantrader.night",
    workdir: "/Users/x/workspace/pantrader",
    logDir: "/Users/x/PanTraderData/logs",
    nodeBin: "/usr/local/bin/node",
    script: "/Users/x/workspace/pantrader/scripts/job.ts",
    jobArgs: ["night", "--runner=launchd"],
    calendar: { Hour: 22, Minute: 0 },
  };

  it("给了 dataDir 就写进 EnvironmentVariables", () => {
    const plist = buildPlist({ ...base, dataDir: "/Volumes/ext/PanTraderData" });
    expect(plist).toContain("<key>EnvironmentVariables</key>");
    expect(plist).toContain("<key>PANTRADER_DATA_DIR</key>");
    expect(plist).toContain("<string>/Volumes/ext/PanTraderData</string>");
  });

  it("没给就不写这一段，沿用默认位置", () => {
    expect(buildPlist(base)).not.toContain("EnvironmentVariables");
  });
});

/**
 * 与 launchd 侧对称：数据目录要固化进任务本身，不指望计划任务继承用户环境变量。
 * 它通常会继承（setx 写的是 HKCU\Environment），但"通常"不够 —— 一旦没继承到，
 * 网页用新路径、采集写默认路径，两个库都不报错，等发现时已经岔开好几天。
 */
describe("计划任务里的数据目录", () => {
  const task = (dataDir?: string) =>
    buildTasks("C:\\Program Files\\nodejs\\node.exe", "C:\\repo\\ai_pantrader", dataDir)[0];

  it("给了 dataDir 就用 cmd /c set 固化进 /TR", () => {
    const args = schtasksArgs(task("C:\\repo\\ai_pantrader\\data"));
    const tr = args[args.indexOf("/TR") + 1];
    expect(tr).toContain("cmd /c set PANTRADER_DATA_DIR=C:\\repo\\ai_pantrader\\data");
    expect(tr).toContain("job.ts");
    expect(tr).toContain("--runner=schtasks");
  });

  it("set 后面紧跟 && 不留空格 —— 留了空格会被算进变量值", () => {
    const args = schtasksArgs(task("C:\\data"));
    const tr = args[args.indexOf("/TR") + 1];
    expect(tr).toContain("PANTRADER_DATA_DIR=C:\\data&&");
    expect(tr).not.toContain("PANTRADER_DATA_DIR=C:\\data &&");
  });

  it("没给 dataDir 就不加 cmd 包装", () => {
    const args = schtasksArgs(task());
    const tr = args[args.indexOf("/TR") + 1];
    expect(tr).not.toContain("cmd /c");
    expect(tr).toContain("job.ts");
  });
});
