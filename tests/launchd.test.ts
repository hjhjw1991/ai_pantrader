import { describe, it, expect } from "vitest";
import { buildPlist, JOB_SCHEDULE } from "@/scripts/install-launchd";

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
