import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createSqliteView } from "@/lib/pit/sqlite-view";
import { makeTempDb, type TempDb } from "./helpers";

let t: TempDb;
beforeEach(() => { t = makeTempDb(); });
afterEach(() => { t.close(); });

const span = (code: string, level: number, ic: string, name: string, from: string, to: string | null) =>
  t.db.prepare(
    `INSERT OR REPLACE INTO sw_industry_span (code, level, index_code, index_name, from_date, to_date)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(code, level, ic, name, from, to);

const val = (code: string, date: string, pe: number | null, pb: number | null) =>
  t.db.prepare(
    `INSERT OR REPLACE INTO valuation_daily (code, date, pe, pb, mktcap, float_mktcap)
     VALUES (?, ?, ?, ?, 1e10, 1e10)`
  ).run(code, date, pe, pb);

describe("industryAt", () => {
  it("落在区间里就返回该行业", () => {
    span("600000", 1, "801780", "银行", "2021-12-13", null);
    const v = createSqliteView(t.db, "2026-09-23 15:05:00");
    expect(v.industryAt("600000", 1)).toEqual({ indexCode: "801780", indexName: "银行" });
  });

  it("区间是 [from, to) 半开 —— 换行业当天算**新**行业", () => {
    span("300750", 1, "801880", "汽车", "2021-12-13", "2026-09-18");
    span("300750", 1, "801730", "电力设备", "2026-09-18", null);
    expect(createSqliteView(t.db, "2026-09-17 15:05:00").industryAt("300750", 1)?.indexName).toBe("汽车");
    expect(createSqliteView(t.db, "2026-09-18 15:05:00").industryAt("300750", 1)?.indexName).toBe("电力设备");
  });

  it("**早于所有区间就返回 null** —— 74.6% 的票 beginningdate 压在 2021-12-13，在那之前申万这套分类根本不存在", () => {
    span("600000", 1, "801780", "银行", "2021-12-13", null);
    expect(createSqliteView(t.db, "2020-06-01 15:05:00").industryAt("600000", 1)).toBeNull();
  });

  it("查不到的票返回 null，不猜", () => {
    expect(createSqliteView(t.db, "2026-09-23 15:05:00").industryAt("999999", 1)).toBeNull();
  });

  it("一级与三级分开查", () => {
    span("600000", 1, "801780", "银行", "2021-12-13", null);
    span("600000", 3, "857841", "国有大型银行Ⅲ", "2021-12-13", null);
    const v = createSqliteView(t.db, "2026-09-23 15:05:00");
    expect(v.industryAt("600000", 1)?.indexCode).toBe("801780");
    expect(v.industryAt("600000", 3)?.indexCode).toBe("857841");
  });
});

describe("valuation", () => {
  it("取不晚于 asOf 的最近一条，并带上它的日期供调用方判新鲜度", () => {
    val("600000", "2026-09-22", 4.85, 0.40);
    val("600000", "2026-09-23", 4.90, 0.41);
    const v = createSqliteView(t.db, "2026-09-23 15:05:00");
    expect(v.valuation("600000")).toMatchObject({ date: "2026-09-23", pe: 4.9, pb: 0.41 });
  });

  it("不会看到未来的估值", () => {
    val("600000", "2026-09-23", 4.90, 0.41);
    expect(createSqliteView(t.db, "2026-09-22 15:05:00").valuation("600000")).toBeNull();
  });

  it("**接入之前的日期返回 null** —— 东财没有历史估值接口，拿今天的 PE 回刷是未来函数，且偏向「今天看着便宜」的票", () => {
    val("600000", "2026-09-23", 4.90, 0.41);
    expect(createSqliteView(t.db, "2024-01-05 15:05:00").valuation("600000")).toBeNull();
  });

  it("亏损股的负 PE 原样返回，不当成缺数据", () => {
    val("000002", "2026-09-23", -1.64, 0.48);
    expect(createSqliteView(t.db, "2026-09-23 15:05:00").valuation("000002")?.pe).toBe(-1.64);
  });

  it("没有记录返回 null", () => {
    expect(createSqliteView(t.db, "2026-09-23 15:05:00").valuation("999999")).toBeNull();
  });
});
