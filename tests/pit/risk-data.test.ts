import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createSqliteView } from "@/lib/pit/sqlite-view";
import { makeTempDb, type TempDb } from "./helpers";

let t: TempDb;
beforeEach(() => { t = makeTempDb(); });
afterEach(() => { t.close(); });

const lift = (code: string, d: string, ratio: number, type = "首发原股东限售股份") =>
  t.db.prepare(
    `INSERT INTO lift_schedule (code, free_date, share_type, free_shares, lift_mktcap, free_ratio, total_ratio)
     VALUES (?, ?, ?, 1e6, 1e7, ?, ?)`
  ).run(code, d, type, ratio, ratio);

const plan = (code: string, start: string, end: string, seen: string, dir = "减持", ratio = 0.01) =>
  t.db.prepare(
    `INSERT INTO reduction_plan (code, actor, direction, start_date, end_date, max_shares, max_ratio, first_seen)
     VALUES (?, '股东甲', ?, ?, ?, 1e6, ?, ?)`
  ).run(code, dir, start, end, ratio, seen);

describe("liftsAhead", () => {
  it("返回 [评估日, 评估日+N天] 内的解禁，含当天 —— 解禁日当天抛压就在眼前", () => {
    lift("600000", "2026-09-23", 0.01);
    lift("600000", "2026-12-20", 0.03);
    lift("600000", "2027-03-01", 0.05);
    const v = createSqliteView(t.db, "2026-09-23 15:05:00");
    expect(v.liftsAhead("600000", 90).map(x => x.date)).toEqual(["2026-09-23", "2026-12-20"]);
  });

  it("已经过去的解禁不算", () => {
    lift("600000", "2026-09-01", 0.05);
    expect(createSqliteView(t.db, "2026-09-23 15:05:00").liftsAhead("600000", 90)).toEqual([]);
  });

  it("带回比例与类型，供因子汇总", () => {
    lift("600000", "2026-10-15", 0.04, "定向增发机构配售股份");
    const r = createSqliteView(t.db, "2026-09-23 15:05:00").liftsAhead("600000", 90)[0];
    expect(r).toMatchObject({ date: "2026-10-15", freeRatio: 0.04, shareType: "定向增发机构配售股份" });
  });
});

describe("reductionPlans", () => {
  it("执行窗口与 [评估日, +N天] 有交集的减持计划", () => {
    plan("002237", "2026-10-23", "2027-01-22", "2026-09-23");
    const v = createSqliteView(t.db, "2026-09-23 15:05:00");
    expect(v.reductionPlans("002237", 90).length).toBe(1);
  });

  it("正在执行中的计划也算 —— 窗口开始了不等于压力没了", () => {
    plan("002237", "2026-09-01", "2026-11-30", "2026-08-10");
    expect(createSqliteView(t.db, "2026-09-23 15:05:00").reductionPlans("002237", 90).length).toBe(1);
  });

  it("已经结束的计划不算", () => {
    plan("002237", "2026-02-26", "2026-05-25", "2026-02-01");
    expect(createSqliteView(t.db, "2026-09-23 15:05:00").reductionPlans("002237", 90)).toEqual([]);
  });

  it("**我们还没看到的计划不算** —— first_seen 晚于评估日就是未来函数", () => {
    plan("002237", "2026-10-23", "2027-01-22", "2026-09-23");
    expect(createSqliteView(t.db, "2026-09-20 15:05:00").reductionPlans("002237", 90)).toEqual([]);
  });

  it("增持计划不在里面 —— 它是利好", () => {
    plan("002237", "2026-10-23", "2027-01-22", "2026-09-23", "增持");
    expect(createSqliteView(t.db, "2026-09-23 15:05:00").reductionPlans("002237", 90)).toEqual([]);
  });

  it("起始日远在窗口之外的不算", () => {
    plan("002237", "2027-06-01", "2027-09-01", "2026-09-23");
    expect(createSqliteView(t.db, "2026-09-23 15:05:00").reductionPlans("002237", 90)).toEqual([]);
  });
});
