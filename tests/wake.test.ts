import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb } from "@/lib/db";
import { runMigrations } from "@/lib/db/migrate";
import {
  lastActivity, findStaleClaims, reclaimStaleClaims, unaccountedDays,
  markUnaccountedMissed, assessWake, wakeSlot, crossedCalendarDay,
  STALE_CLAIM_FLOOR_MIN, WAKE_GAP_MIN,
} from "@/lib/data/wake";
import { dueSlots, createScheduler } from "@/lib/data/scheduler";
import { SCHEDULE } from "@/lib/data/schedule";
import { setMeta } from "@/lib/data/meta";

let dir: string, db: any;

/** 2026-08-03(一) 到 08-07(五) 都是交易日，08-08/09 周末 */
const CAL: Array<[string, number]> = [
  ["2026-08-03", 1], ["2026-08-04", 1], ["2026-08-05", 1],
  ["2026-08-06", 1], ["2026-08-07", 1], ["2026-08-08", 0], ["2026-08-09", 0],
  ["2026-08-10", 1],
];

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "pt-wake-"));
  db = openDb(path.join(dir, "t.db"));
  runMigrations(db);
  const ins = db.prepare("INSERT INTO trading_calendar (date,is_open,source) VALUES (?,?,'t')");
  for (const [d, o] of CAL) ins.run(d, o);
  setMeta(db, "system_start_date", "2026-08-03");
});
afterEach(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });

const at = (iso: string) => new Date(`${iso}+08:00`);

const run = (date: string, job: string, slot: string, status: string,
             startedAt?: string, finishedAt?: string) =>
  db.prepare(
    `INSERT INTO job_run (date,job,slot,status,started_at,finished_at,runner)
     VALUES (?,?,?,?,?,?,'scheduler')`
  ).run(date, job, slot, status, startedAt ?? null, finishedAt ?? null);

describe("lastActivity", () => {
  it("空库返回 null —— 首次运行不该触发任何补偿", () => {
    expect(lastActivity(db)).toBeNull();
  });

  it("取最后一次活动，未结束的行用 started_at", () => {
    run("2026-08-03", "night", "22:00", "done", "2026-08-03 22:00:00.000", "2026-08-03 22:31:00.000");
    run("2026-08-05", "intraday", "09:35", "running", "2026-08-05 09:35:02.000");
    expect(lastActivity(db)).toBe("2026-08-05 09:35:02.000");
  });

  it("missed 行没有 started_at，不参与 lastActivity —— 否则'漏采'会被当成'干过活'", () => {
    run("2026-08-03", "night", "22:00", "done", "2026-08-03 22:00:00.000", "2026-08-03 22:31:00.000");
    run("2026-08-05", "intraday", "09:35", "missed");
    expect(lastActivity(db)).toBe("2026-08-03 22:31:00.000");
  });
});

describe("running 残留回收", () => {
  it("门槛内的 running 不动 —— night 正常要跑 40 分钟", () => {
    run("2026-08-05", "night", "22:00", "running", "2026-08-05 22:00:00.000");
    const stale = findStaleClaims(db, at("2026-08-05T22:30:00"));
    expect(stale).toEqual([]);
  });

  it("超过 durationMin×3 判为残留", () => {
    run("2026-08-05", "night", "22:00", "running", "2026-08-05 22:00:00.000");
    // night durationMin=40 → 门槛 120 分钟
    expect(findStaleClaims(db, at("2026-08-06T00:05:00")).length).toBe(1);
  });

  it("短 job 有 15 分钟地板 —— limiter 排队 + 熔断退避能拖很久", () => {
    run("2026-08-05", "preopen", "09:00", "running", "2026-08-05 09:00:00.000");
    const early = findStaleClaims(db, at("2026-08-05T09:10:00"));
    expect(early).toEqual([]);
    const late = findStaleClaims(
      db, at(`2026-08-05T09:${String(STALE_CLAIM_FLOOR_MIN + 1).padStart(2, "0")}:00`)
    );
    expect(late.length).toBe(1);
  });

  it("门槛对健康的慢 job 留足余量 —— night 实测 30 分钟，门槛 120 分钟", () => {
    run("2026-08-05", "night", "22:00", "running", "2026-08-05 22:00:00.000");
    // 实测最慢一次 29 分钟；就算翻倍到 60 分钟也不会被同机另一个 runner 抢走
    expect(findStaleClaims(db, at("2026-08-05T23:00:00"))).toEqual([]);
  });

  it("当天、日内重跑有意义的残留 → requeue（删占位让它重跑）", () => {
    // 用 close：durationMin=3 → 门槛取 15 分钟地板。
    // night 反而做不到同日 requeue —— 22:00 + 120 分钟已经跨到次日了
    run("2026-08-05", "close", "15:05", "running", "2026-08-05 15:05:00.000");
    const stale = findStaleClaims(db, at("2026-08-05T15:30:00"));
    expect(stale[0].action).toBe("requeue");
    reclaimStaleClaims(db, stale);
    expect(db.prepare("SELECT COUNT(*) c FROM job_run").get().c).toBe(0);
  });

  it("过去日期的残留一律 fail，绝不 requeue —— dueSlots 只看今天，删了等于凭空消失", () => {
    run("2026-08-05", "night", "22:00", "running", "2026-08-05 22:00:00.000");
    const stale = findStaleClaims(db, at("2026-08-06T02:00:00"));
    expect(stale[0].action).toBe("fail");
    reclaimStaleClaims(db, stale);
    // 行还在，账不丢；日线本身由 night 补偿覆盖
    expect(db.prepare("SELECT status FROM job_run").get().status).toBe("failed");
  });

  it("快照类 job 残留 → 记 failed，不重跑（过去时点的现场补不回来）", () => {
    run("2026-08-05", "intraday", "09:35", "running", "2026-08-05 09:35:00.000");
    const stale = findStaleClaims(db, at("2026-08-05T11:00:00"));
    expect(stale[0].action).toBe("fail");
    reclaimStaleClaims(db, stale);
    const r = db.prepare("SELECT status, error FROM job_run").get();
    expect(r.status).toBe("failed");
    expect(r.error).toContain("进程中断");
  });

  it("回收后被卡住的时点重新变成 pending —— 这是整件事的意义", () => {
    // close@15:05 卡在 running：claimed() 认为已占，dueSlots 看不到它
    run("2026-08-05", "close", "15:05", "running", "2026-08-05 15:05:00.000");
    const before = dueSlots(db, at("2026-08-05T15:30:00"));
    expect(before.some(d => d.job === "close")).toBe(false);
    reclaimStaleClaims(db, findStaleClaims(db, at("2026-08-05T15:30:00")));
    const after = dueSlots(db, at("2026-08-05T15:31:00"));
    expect(after.some(d => d.job === "close" && d.action === "run")).toBe(true);
  });
});

describe("未结清交易日", () => {
  it("上次活动到今天之间的每个交易日，不含今天", () => {
    run("2026-08-03", "night", "22:00", "done", "2026-08-03 22:00:00.000", "2026-08-03 22:31:00.000");
    expect(unaccountedDays(db, "2026-08-03", "2026-08-07"))
      .toEqual(["2026-08-03", "2026-08-04", "2026-08-05", "2026-08-06"]);
  });

  it("不含今天 —— 今天的时点归常规 dueSlots 管，那才是权威路径", () => {
    expect(unaccountedDays(db, "2026-08-04", "2026-08-04")).toEqual([]);
  });

  it("周末不算 —— 休市不是漏采", () => {
    expect(unaccountedDays(db, "2026-08-08", "2026-08-10")).toEqual([]);
  });

  it("不回溯到系统起始日之前 —— 上线前的历史不是缺口", () => {
    setMeta(db, "system_start_date", "2026-08-05");
    expect(unaccountedDays(db, "2026-08-03", "2026-08-07")).toEqual(["2026-08-05", "2026-08-06"]);
  });

  it("那天有部分 job_run 也照样算 —— 半天睡过去才是最常见的漏法", () => {
    run("2026-08-04", "intraday", "09:35", "done", "2026-08-04 09:35:00.000", "2026-08-04 09:35:40.000");
    expect(unaccountedDays(db, "2026-08-04", "2026-08-05")).toEqual(["2026-08-04"]);
  });
});

describe("不可回补时点补记 missed", () => {
  /*
   * plan 也在这一类里：盘前计划算的是"今天开盘前该看哪几只"，
   * 今天补一份上周五的计划只会拿今天的数据编造一个当时不存在的结论 ——
   * 和 close 补跑拿到今天的涨停池是同一种错。
   */
  it("只标 backfillsAcrossDays=false 的 job（intraday/close/plan）", () => {
    const n = markUnaccountedMissed(db, ["2026-08-04"]);
    const jobs = db.prepare(
      "SELECT DISTINCT job FROM job_run WHERE date='2026-08-04' ORDER BY job"
    ).all().map((r: any) => r.job);
    expect(jobs).toEqual(["close", "intraday", "plan"]);
    // 48 个盘中 + 1 个收盘 + 1 个盘前计划
    expect(n).toBe(50);
    for (const r of db.prepare("SELECT status FROM job_run").all()) {
      expect(r.status).toBe("missed");
    }
  });

  it("close 是 catchUp=all 但跨天补不回来，必须被标上 —— 两个轴别混", () => {
    markUnaccountedMissed(db, ["2026-08-04"]);
    expect(db.prepare(
      "SELECT status FROM job_run WHERE date='2026-08-04' AND job='close'"
    ).get().status).toBe("missed");
    // night 可回补，不标（由补偿真跑），标了就是重复记账
    expect(db.prepare(
      "SELECT 1 FROM job_run WHERE date='2026-08-04' AND job='night'"
    ).get()).toBeUndefined();
  });

  it("非交易日一个都不标", () => {
    expect(markUnaccountedMissed(db, ["2026-08-08"])).toBe(0);
  });

  it("幂等：重复调用不翻倍（INSERT OR IGNORE）", () => {
    markUnaccountedMissed(db, ["2026-08-04"]);
    expect(markUnaccountedMissed(db, ["2026-08-04"])).toBe(0);
    expect(db.prepare("SELECT COUNT(*) c FROM job_run").get().c).toBe(50);
  });

  it("不覆盖已有记录 —— 那天真跑过的 done 不能被改写成 missed", () => {
    run("2026-08-04", "intraday", "09:35", "done", "2026-08-04 09:35:00.000", "2026-08-04 09:35:40.000");
    const n = markUnaccountedMissed(db, ["2026-08-04"]);
    expect(db.prepare(
      "SELECT status FROM job_run WHERE date='2026-08-04' AND slot='09:35'"
    ).get().status).toBe("done");
    // 只补了剩下的 49 个（48 盘中 + 收盘 + 盘前计划，减去已 done 的那一个）
    expect(n).toBe(49);
  });
});

describe("assessWake", () => {
  it("首次运行不补偿", () => {
    const a = assessWake(db, at("2026-08-05T10:00:00"), lastActivity(db));
    expect(a.lastSeen).toBeNull();
    expect(a.compensate).toEqual([]);
    expect(a.reason).toContain("首次运行");
  });

  it("有未落地的交易日 → 补跑 night 一次（preopen 是判据前提，另行处理）", () => {
    run("2026-08-03", "night", "22:00", "done", "2026-08-03 22:00:00.000", "2026-08-03 22:31:00.000");
    const a = assessWake(db, at("2026-08-06T09:00:00"), lastActivity(db));
    expect(a.unsettled).toEqual(["2026-08-04", "2026-08-05"]);
    // 结构性覆盖：night 一次拉 1023 根日线，不逐日重放
    expect(a.compensate).toEqual(["night"]);
    expect(a.compensate.filter(j => j === "night").length).toBe(1);
  });

  it("night 跑成过的日子算已结清，不重复补", () => {
    run("2026-08-04", "night", "22:00", "done", "2026-08-04 22:00:00.000", "2026-08-04 22:31:00.000");
    run("2026-08-05", "night", "22:00", "done", "2026-08-05 22:00:00.000", "2026-08-05 22:31:00.000");
    const a = assessWake(db, at("2026-08-06T09:00:00"), lastActivity(db));
    expect(a.unaccounted).toEqual(["2026-08-05"]);
    expect(a.unsettled).toEqual([]);
    expect(a.compensate).toEqual([]);
  });

  it("night 那天 failed 不算结清 —— 这是早前把'没抛错'当成功栽的同一个坑", () => {
    run("2026-08-05", "night", "22:00", "failed", "2026-08-05 22:00:00.000", "2026-08-05 22:05:00.000");
    const a = assessWake(db, at("2026-08-06T09:00:00"), lastActivity(db));
    expect(a.unsettled).toEqual(["2026-08-05"]);
    expect(a.compensate.length).toBeGreaterThan(0);
  });

  it("触发条件是数据落地而非沉睡时长：周末关机 60 小时不补", () => {
    run("2026-08-07", "night", "22:00", "done", "2026-08-07 22:00:00.000", "2026-08-07 22:31:00.000");
    const a = assessWake(db, at("2026-08-10T09:00:00"), lastActivity(db));
    expect(a.dormantMin).toBeGreaterThan(58 * 60);
    expect(a.compensate).toEqual([]);
  });

  it("触发条件是数据落地而非沉睡时长：只隔 10 小时但漏掉整个交易日要补", () => {
    run("2026-08-04", "night", "22:00", "done", "2026-08-04 22:00:00.000", "2026-08-04 23:00:00.000");
    const a = assessWake(db, at("2026-08-06T09:00:00"), lastActivity(db));
    expect(a.unsettled).toEqual(["2026-08-05"]);
    expect(a.compensate.length).toBeGreaterThan(0);
  });

  it("补偿的 job 必须都是声明了 backfillsAcrossDays 的 —— 否则补了个空", () => {
    run("2026-08-03", "night", "22:00", "done", "2026-08-03 22:00:00.000", "2026-08-03 22:31:00.000");
    const a = assessWake(db, at("2026-08-06T09:00:00"), lastActivity(db));
    for (const j of a.compensate) {
      expect(SCHEDULE.find(s => s.job === j)!.backfillsAcrossDays).toBe(true);
    }
  });

  it("assessWake 只读，不写库", () => {
    run("2026-08-03", "night", "22:00", "running", "2026-08-03 22:00:00.000");
    const before = db.prepare("SELECT COUNT(*) c FROM job_run").get().c;
    assessWake(db, at("2026-08-06T09:00:00"), lastActivity(db));
    expect(db.prepare("SELECT COUNT(*) c FROM job_run").get().c).toBe(before);
    expect(db.prepare("SELECT status FROM job_run").get().status).toBe("running");
  });
});

describe("日历必须先同步，再评估漏采日", () => {
  it("crossedCalendarDay：跨过日历日才需要同步日历", () => {
    expect(crossedCalendarDay("2026-08-05 22:31:00.000", at("2026-08-05T23:00:00"))).toBe(false);
    expect(crossedCalendarDay("2026-08-05 22:31:00.000", at("2026-08-06T00:01:00"))).toBe(true);
    expect(crossedCalendarDay(null, at("2026-08-06T00:01:00"))).toBe(false);
  });

  it("日历缺沉睡期间的日期时，漏采日恒为 0 —— 这就是必须先同步的原因", () => {
    // trading_calendar 是从指数历史 K 线推出来的，max(date) 永远是"上次同步那天"，
    // 绝不含未来日期。模拟关机两周：日历只到 08-05
    db.prepare("DELETE FROM trading_calendar WHERE date > '2026-08-05'").run();
    run("2026-08-05", "night", "22:00", "failed", "2026-08-05 22:00:00.000", "2026-08-05 22:05:00.000");
    const a = assessWake(db, at("2026-08-07T09:00:00"), lastActivity(db));
    // 08-06 / 08-07 在日历里不存在 → 查不出来
    expect(a.unaccounted).toEqual(["2026-08-05"]);
    // 补日历之后才看得见（preopen 干的事）
    db.prepare("INSERT INTO trading_calendar (date,is_open,source) VALUES ('2026-08-06',1,'t')").run();
    const b = assessWake(db, at("2026-08-07T09:00:00"), lastActivity(db));
    expect(b.unaccounted).toEqual(["2026-08-05", "2026-08-06"]);
  });

  it("回收残留不写 finished_at —— 否则 lastActivity 变成'刚刚'，补偿凭空消失", () => {
    run("2026-08-05", "intraday", "10:00", "running", "2026-08-05 10:00:00.000");
    const before = lastActivity(db);
    reclaimStaleClaims(db, findStaleClaims(db, at("2026-08-07T09:00:00")));
    expect(lastActivity(db)).toBe(before);
    expect(db.prepare("SELECT finished_at FROM job_run").get().finished_at).toBeNull();
    // 回收之后评估仍然认得出漏采
    const a = assessWake(db, at("2026-08-06T09:00:00"), lastActivity(db));
    expect(a.unsettled).toEqual(["2026-08-05"]);
    expect(a.compensate).toEqual(["night"]);
  });
});

describe("wakeSlot", () => {
  it("与时刻表时点区分开，不占用真实时点", () => {
    const s = wakeSlot(at("2026-08-05T09:36:07"));
    expect(s).toBe("wake:09:36:07");
    // 所有真实时点都是 HH:MM，绝不会撞
    for (const j of SCHEDULE) expect(j.slots).not.toContain(s);
  });
});

describe("调度器接入唤醒补偿", () => {
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

  it("第一轮 tick 就做唤醒评估，回收残留并记 missed", async () => {
    // 08-04 卡死的 intraday + 08-05 整天暗
    run("2026-08-04", "intraday", "10:00", "running", "2026-08-04 10:00:00.000");
    const events: any[] = [];
    const s = createScheduler({
      db, clients: clients(), runner: "scheduler",
      now: () => at("2026-08-06T08:00:00"),
      onEvent: e => events.push(e),
    });
    await s.tickOnce();

    const wake = events.find(e => e.kind === "wake");
    expect(wake).toBeDefined();
    expect(wake.assessment.unsettled).toEqual(["2026-08-04", "2026-08-05"]);
    // 残留被改成 failed（快照不可回补）
    expect(db.prepare(
      "SELECT status FROM job_run WHERE date='2026-08-04' AND slot='10:00'"
    ).get().status).toBe("failed");
    // 漏采日的快照时点如实记 missed
    expect(db.prepare(
      "SELECT COUNT(*) c FROM job_run WHERE date='2026-08-05' AND status='missed'"
    ).get().c).toBe(50);
    // 08-04 已经有一条 10:00 的残留行，其余 49 个补记 missed，不覆盖那一条
    expect(db.prepare(
      "SELECT COUNT(*) c FROM job_run WHERE date='2026-08-04' AND status='missed'"
    ).get().c).toBe(49);
    // 补偿真的跑了，用 wake: 标签，不占真实时点
    const comp = db.prepare(
      "SELECT job, slot FROM job_run WHERE date='2026-08-06' AND slot LIKE 'wake:%' ORDER BY job"
    ).all();
    expect(comp.map((r: any) => r.job)).toContain("night");
    expect(comp.map((r: any) => r.job)).toContain("preopen");
  });

  it("第二轮 tick 不再重复评估 —— 否则每 30 秒补一次 night", async () => {
    run("2026-08-03", "night", "22:00", "done", "2026-08-03 22:00:00.000", "2026-08-03 22:31:00.000");
    const events: any[] = [];
    const s = createScheduler({
      db, clients: clients(), runner: "scheduler",
      now: () => at("2026-08-06T08:00:00"),
      onEvent: e => events.push(e),
    });
    await s.tickOnce();
    const first = events.filter(e => e.kind === "wake").length;
    events.length = 0;
    await s.tickOnce();
    expect(events.filter(e => e.kind === "wake").length).toBe(0);
    expect(first).toBe(1);
  });

  it("先同步日历再评估 —— 日历缺沉睡期间的日期时，这个顺序决定补偿会不会静默失效", async () => {
    // 日历只到 08-05（真实形态：从指数历史 K 线推出来，永远不含未来日期）
    db.prepare("DELETE FROM trading_calendar WHERE date > '2026-08-05'").run();
    run("2026-08-05", "night", "22:00", "failed", "2026-08-05 22:00:00.000", "2026-08-05 22:05:00.000");
    // preopen 会拿这份 K 线把 08-06 补进日历
    const kline = JSON.stringify(
      ["2026-08-05", "2026-08-06"].map(d => ({
        day: `${d} 15:00:00`, open: 1, high: 1, low: 1, close: 1, volume: 1,
      }))
    );
    const events: any[] = [];
    const s = createScheduler({
      db, clients: { ...clients(), sina: stub(kline) as any }, runner: "scheduler",
      now: () => at("2026-08-07T08:00:00"),
      onEvent: e => events.push(e),
    });
    await s.tickOnce();
    // 日历被补上了
    expect(db.prepare(
      "SELECT 1 FROM trading_calendar WHERE date='2026-08-06'"
    ).get()).toBeDefined();
    // 而且评估用的是补完之后的日历：08-06 也被认作漏采日
    const wake = events.find(e => e.kind === "wake");
    expect(wake.assessment.unaccounted).toContain("2026-08-06");
    expect(wake.assessment.unsettled).toContain("2026-08-06");
  });

  it("同一轮内 dueSlots 已跑成 night，补偿就不再跑 —— 别白花 40 分钟拉同一批日线", async () => {
    // 唤醒评估发生在 dueSlots 之前，那时今天的 night 还没跑；
    // dueSlots 跑成之后补偿才轮到，这时必须认出"已经有了"
    run("2026-08-04", "night", "22:00", "failed", "2026-08-04 22:00:00.000", "2026-08-04 22:05:00.000");
    const events: any[] = [];
    const s = createScheduler({
      db, clients: clients(), runner: "scheduler",
      now: () => at("2026-08-06T22:40:00"),
      onEvent: e => events.push(e),
    });
    await s.tickOnce();
    // 评估阶段确实决定了要补 night
    expect(events.find(e => e.kind === "wake").assessment.compensate).toEqual(["night"]);
    // 但 dueSlots 已经把今天的 night 跑成了，补偿被跳过
    expect(db.prepare(
      "SELECT status FROM job_run WHERE date='2026-08-06' AND job='night' AND slot='22:00'"
    ).get().status).toBe("done");
    expect(events.some(e => e.kind === "skip" && e.job === "night"
      && e.reason.includes("已成功跑过"))).toBe(true);
    expect(db.prepare(
      "SELECT COUNT(*) c FROM job_run WHERE job='night' AND slot LIKE 'wake:%'"
    ).get().c).toBe(0);
  });

  it("没有暗日也没有残留时完全静默，不发 wake 事件", async () => {
    run("2026-08-06", "selfcheck", "08:50", "done", "2026-08-06 07:59:00.000", "2026-08-06 07:59:30.000");
    const events: any[] = [];
    const s = createScheduler({
      db, clients: clients(), runner: "scheduler",
      now: () => at("2026-08-06T08:00:00"),
      onEvent: e => events.push(e),
    });
    await s.tickOnce();
    expect(events.filter(e => e.kind === "wake")).toEqual([]);
  });

  it("WAKE_GAP_MIN 必须大于 tick 间隔，否则每轮都当成刚醒", () => {
    expect(WAKE_GAP_MIN * 60_000).toBeGreaterThan(30_000);
  });
});
