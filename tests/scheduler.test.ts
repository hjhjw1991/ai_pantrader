import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb } from "@/lib/db";
import { runMigrations } from "@/lib/db/migrate";
import { createScheduler, dueSlots, todayRuns } from "@/lib/data/scheduler";
import { SCHEDULE, intradaySlots, awakeWindows, hmToMinutes, allSlots } from "@/lib/data/schedule";

let dir: string, db: any;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "pt-sched-"));
  db = openDb(path.join(dir, "t.db"));
  runMigrations(db);
  db.prepare("INSERT INTO trading_calendar (date,is_open,source) VALUES ('2026-08-05',1,'t')").run();
});
afterEach(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });

/** 上海时间 HH:MM 对应的 Date */
const at = (hm: string) => new Date(`2026-08-05T${hm}:00+08:00`);

const stub = (text: string) => ({
  source: "stub",
  breaker: { isOpen: () => false, record() {}, reset() {} } as any,
  async get() { return { ok: true as const, text, status: 200, latencyMs: 1 }; },
});
const clients = () => ({
  sina: stub("[]") as any,
  tencent: stub('v_sh000001="1~x~000001~1~1~1~1~1~1~1~1~1~1~1~1~1~1~1~1~1~1~1~1~1~1~1~1~1~1~1~20260805100000~1~1~1~1~1~1~1~1~1~1~1~1~1~1~1~1~1~1~1~1~1~1~1~1~1~1~1~1~1~1~1~1~1~1~1~1~1~1~1~1~1~1~1~1~1~1~1~1~1~1~1~1~1~1~1~1~1";') as any,
  eastmoney: stub(JSON.stringify({ data: { pool: [] }, result: { pages: 1, data: [] } })) as any,
});

describe("时刻表", () => {
  it("盘中 48 个时点，避开午休", () => {
    const s = intradaySlots();
    expect(s.length).toBe(48);
    expect(s[0]).toBe("09:35");
    expect(s[s.length - 1]).toBe("14:55");
    expect(s).not.toContain("12:00");
    expect(s).not.toContain("11:35");
  });

  it("防休眠时段由时刻表自动推出 —— 手写会和时刻表漂移", () => {
    const w = awakeWindows();
    // 盘中时段必须覆盖第一个 intraday 到 close
    const session = w.find(x => hmToMinutes(x.from) <= hmToMinutes("09:35"))!;
    expect(session).toBeDefined();
    expect(hmToMinutes(session.to)).toBeGreaterThanOrEqual(hmToMinutes("15:05"));
    // 每个 job 时点都得落在某个时段里
    for (const { slot } of allSlots()) {
      const covered = w.some(x =>
        hmToMinutes(slot) >= hmToMinutes(x.from) && hmToMinutes(slot) <= hmToMinutes(x.to));
      expect(covered, `${slot} 未被任何防休眠时段覆盖`).toBe(true);
    }
  });
});

describe("dueSlots", () => {
  it("只取已到点的时点", () => {
    const due = dueSlots(db, at("09:41"));
    const intr = due.filter(d => d.job === "intraday").map(d => d.slot);
    expect(intr).toEqual(["09:35", "09:40"]);
  });

  it("盘中补跑只跑最后一个，其余记 missed —— 连补 6 次拿的是同一份当前行情", () => {
    const due = dueSlots(db, at("10:07")).filter(d => d.job === "intraday");
    const run = due.filter(d => d.action === "run").map(d => d.slot);
    const missed = due.filter(d => d.action === "missed").map(d => d.slot);
    expect(run).toEqual(["10:05"]);
    expect(missed).toEqual(["09:35", "09:40", "09:45", "09:50", "09:55", "10:00"]);
  });

  it("单次 job 过点后仍补跑（晚跑仍有意义）", () => {
    const due = dueSlots(db, at("09:10"));
    expect(due.find(d => d.job === "preopen")?.action).toBe("run");
    expect(due.find(d => d.job === "selfcheck")?.action).toBe("run");
  });

  it("已有 job_run 记录的时点不再出现", () => {
    db.prepare(
      "INSERT INTO job_run (date,job,slot,status,runner) VALUES ('2026-08-05','intraday','09:35','done','launchd')"
    ).run();
    const intr = dueSlots(db, at("09:41")).filter(d => d.job === "intraday").map(d => d.slot);
    expect(intr).toEqual(["09:40"]);
  });

  it("时点按上海时间判定，不受宿主时区影响", () => {
    // 同一瞬间：上海 09:36 / UTC 01:36。按 UTC 判会认为什么都没到点
    expect(dueSlots(db, new Date("2026-08-05T01:36:00Z")).some(d => d.job === "intraday")).toBe(true);
  });
});

describe("createScheduler", () => {
  it("启动即执行一轮 —— 跑起系统就自动采集", async () => {
    const events: string[] = [];
    const s = createScheduler({
      db, clients: clients(), now: () => at("09:36"),
      onEvent: e => events.push(`${e.kind}:${e.job}@${e.slot}`),
    });
    await s.tickOnce();
    expect(events.some(e => e.startsWith("run:intraday@09:35"))).toBe(true);
    const runs = todayRuns(db, "2026-08-05");
    expect(runs.find(r => r.job === "intraday" && r.slot === "09:35")?.status).toBe("done");
  });

  it("同一时点不会被执行两次（与 launchd 共存去重）", async () => {
    const runs: string[] = [];
    const mk = () => createScheduler({
      db, clients: clients(), now: () => at("09:36"),
      onEvent: e => { if (e.kind === "run") runs.push(`${e.job}@${e.slot}`); },
    });
    await mk().tickOnce();
    const first = [...runs];
    expect(first.length).toBeGreaterThan(0);
    // 同一份时点集合全部被占用后，第二个 runner（另一进程 / launchd）应当一个都不跑
    runs.length = 0;
    await mk().tickOnce();
    expect(runs).toEqual([]);
    // 且每个时点在台账里只有一行（主键保证），不会重复采集 5888 只
    const n = db.prepare(
      "SELECT COUNT(*) n FROM job_run WHERE date='2026-08-05' AND status='done'").get() as any;
    expect(n.n).toBe(first.length);
  });

  it("job 抛错记 failed 并继续后面的时点，不中断整轮", async () => {
    const bad = {
      source: "boom",
      breaker: { isOpen: () => false, record() {}, reset() {} } as any,
      async get() { return { ok: false as const, error: "empty response body", latencyMs: 1 }; },
    };
    const events: string[] = [];
    const s = createScheduler({
      db, clients: { ...clients(), eastmoney: bad as any },
      now: () => at("18:45"),
      onEvent: e => events.push(`${e.kind}:${e.job}`),
    });
    await s.tickOnce();
    // post 会失败，但 selfcheck/preopen/intraday/close 仍应被处理
    expect(events.some(e => e === "fail:post")).toBe(true);
    expect(events.filter(e => e.startsWith("run:")).length).toBeGreaterThan(0);
  });

  it("非交易日不标 missed —— 那不是漏采，标了会变成长期噪音", async () => {
    db.prepare("UPDATE trading_calendar SET is_open=0 WHERE date='2026-08-05'").run();
    const events: string[] = [];
    const s = createScheduler({
      db, clients: clients(), now: () => at("14:00"),
      onEvent: e => events.push(e.kind),
    });
    await s.tickOnce();
    expect(events).not.toContain("missed");
  });

  it("missed 记录成 missed 而不是 done —— 把没采到的记成成功等于伪造覆盖率", async () => {
    const s = createScheduler({ db, clients: clients(), now: () => at("10:07") });
    await s.tickOnce();
    const r = todayRuns(db, "2026-08-05").filter(x => x.job === "intraday");
    expect(r.find(x => x.slot === "09:35")?.status).toBe("missed");
    expect(r.find(x => x.slot === "10:05")?.status).toBe("done");
  });

  it("start/stop 幂等，stop 后不再触发", () => {
    const s = createScheduler({ db, clients: clients(), now: () => at("03:00"), tickMs: 10_000 });
    s.start(); s.start();
    expect(s.running).toBe(true);
    s.stop();
    expect(s.running).toBe(false);
  });
});
