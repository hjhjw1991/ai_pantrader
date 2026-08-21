import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb } from "@/lib/db";
import { runMigrations } from "@/lib/db/migrate";
import { claimSlot, finishSlot } from "@/lib/data/scheduler";
import { slotForNow } from "@/lib/data/schedule";

/**
 * 起因：OS 级定时任务（launchd / schtasks）走 scripts/job.ts，**从来不写 job_run**，
 * 而进程内调度器靠 job_run 的主键 (date, job, slot) 去重。两边因此互相看不见 ——
 * 实测 2026-08-21：launchd 在 18:40 和 22:00 各跑过 post/night，随后网页一启动，
 * 进程内调度器发现 job_run 里没有记录，把两个 job 又整个跑了一遍。
 *
 * 盘中更贵：48 个时点每次全市场 5887 只快照，翻倍等于白烧一天的限频额度，
 * 而东财实测十几次请求就整体掉线 —— 两边互相把对方打挂。
 *
 * 所以 job.ts 必须先认领时点再执行。认领用的就是同一张表、同一个主键。
 */

let dir: string, db: any;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "pt-claim-"));
  db = openDb(path.join(dir, "t.db"));
  runMigrations(db);
});
afterEach(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });

/** 上海时间 HH:MM 对应的 Date */
const at = (hm: string) => new Date(`2026-08-05T${hm}:00+08:00`);

describe("slotForNow：把'现在几点'反查成时刻表里的时点", () => {
  it("定时任务按点触发，落在自己那个时点上", () => {
    expect(slotForNow("night", at("22:00"))).toBe("22:00");
    expect(slotForNow("post", at("18:40"))).toBe("18:40");
    expect(slotForNow("intraday", at("10:05"))).toBe("10:05");
  });

  it("触发晚了几十秒仍算同一个时点 —— launchd 不保证秒级准时", () => {
    expect(slotForNow("night", new Date("2026-08-05T22:00:47+08:00"))).toBe("22:00");
    expect(slotForNow("intraday", new Date("2026-08-05T10:05:59+08:00"))).toBe("10:05");
  });

  it("不认还没到的时点 —— launchd / schtasks 只会晚触发，不会早", () => {
    // 反过来给早到留余量会打架：10:09 若允许提前 2 分钟，就会认成 10:10 这个
    // 还没发生的时点，而正确答案是刚过去的 10:05
    expect(slotForNow("night", at("21:59"))).toBeNull();
  });

  it("盘中取的是'刚过去的那个'时点，不是下一个", () => {
    expect(slotForNow("intraday", at("10:07"))).toBe("10:05");
    expect(slotForNow("intraday", at("10:09"))).toBe("10:05");
  });

  it("晚得太多也不认：这时候现场早变了，占坑等于把别人的时点标成自己跑过", () => {
    // 14:55 的盘中时点，16:30 才跑 —— 拿到的是收盘价，不是 14:55 的盘口
    expect(slotForNow("intraday", at("16:30"))).toBeNull();
    // 边界内仍然认：休眠唤醒后晚半小时补上，仍是同一个时点该做的事
    expect(slotForNow("night", at("22:30"))).toBe("22:00");
  });

  it("离任何时点都太远 → null：这是人手敲的临时执行，不该占别人的坑", () => {
    expect(slotForNow("night", at("14:00"))).toBeNull();
    expect(slotForNow("intraday", at("03:00"))).toBeNull();
  });
});

describe("claimSlot：两个 runner 抢同一个时点，只有一个能跑", () => {
  it("先到的拿到，后到的被拒", () => {
    expect(claimSlot(db, "2026-08-05", "night", "22:00", "launchd")).toBe(true);
    expect(claimSlot(db, "2026-08-05", "night", "22:00", "scheduler")).toBe(false);
  });

  it("被拒之后表里只留第一个 runner 的那条记录", () => {
    claimSlot(db, "2026-08-05", "night", "22:00", "launchd");
    claimSlot(db, "2026-08-05", "night", "22:00", "scheduler");
    const rows = db.prepare(
      `SELECT runner, status FROM job_run WHERE date='2026-08-05' AND job='night'`
    ).all();
    expect(rows.length).toBe(1);
    expect(rows[0].runner).toBe("launchd");
  });

  it("finishSlot 落结果，覆盖率统计才看得见 OS 级任务的执行", () => {
    claimSlot(db, "2026-08-05", "post", "18:40", "launchd");
    finishSlot(db, "2026-08-05", "post", "18:40", "done", { lhbRows: 68 });
    const r: any = db.prepare(
      `SELECT status, stats_json, finished_at FROM job_run
       WHERE date='2026-08-05' AND job='post' AND slot='18:40'`
    ).get();
    expect(r.status).toBe("done");
    expect(JSON.parse(r.stats_json).lhbRows).toBe(68);
    expect(r.finished_at).not.toBeNull();
  });

  it("失败也要落 failed，否则下次启动会把它当成没跑过再来一遍", () => {
    claimSlot(db, "2026-08-05", "night", "22:00", "launchd");
    finishSlot(db, "2026-08-05", "night", "22:00", "failed", undefined, "源掉线");
    const r: any = db.prepare(
      `SELECT status, error FROM job_run WHERE date='2026-08-05' AND job='night'`
    ).get();
    expect(r.status).toBe("failed");
    expect(r.error).toBe("源掉线");
  });
});

describe("装计划任务时把 runner 写进命令行", () => {
  it("launchd 的 plist argv 带 --runner=launchd", async () => {
    const { buildPlist } = await import("@/scripts/install-launchd");
    const plist = buildPlist({
      label: "com.pantrader.close", nodeBin: "/n", script: "scripts/job.ts",
      jobArgs: ["close", "--runner=launchd"], workdir: "/w", logDir: "/l",
      calendar: { Hour: 15, Minute: 5 },
    });
    expect(plist).toContain("<string>--runner=launchd</string>");
  });

  it("Windows 计划任务同理 —— 两个平台都要能在 job_run 里认出自己", async () => {
    const { buildTasks } = await import("@/scripts/install-schtasks");
    const tasks = buildTasks("C:\\node.exe", "C:\\pantrader");
    expect(tasks.length).toBeGreaterThan(0);
    for (const t of tasks) expect(t.argv).toContain("--runner=schtasks");
  });
});
