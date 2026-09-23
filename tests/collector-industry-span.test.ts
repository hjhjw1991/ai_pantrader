import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb } from "@/lib/db";
import { runMigrations } from "@/lib/db/migrate";
import { buildIndustrySpans } from "@/lib/data/collectors/industry-span";

let dir: string, db: any;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "pt-span-"));
  db = openDb(path.join(dir, "t.db"));
  runMigrations(db);
});
afterEach(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });

/** 一条快照行 */
const snap = (
  snapshotDate: string, code: string, indexCode: string, indexName: string,
  beginningDate: string, level = 1
) => db.prepare(
  `INSERT OR REPLACE INTO sw_industry_snapshot
     (snapshot_date, code, level, index_code, index_name, weight, beginning_date)
   VALUES (?, ?, ?, ?, ?, 1.0, ?)`
).run(snapshotDate, code, level, indexCode, indexName, beginningDate);

const spans = (code: string, level = 1) =>
  db.prepare(
    "SELECT index_code, index_name, from_date, to_date FROM sw_industry_span WHERE code=? AND level=? ORDER BY from_date"
  ).all(code, level).map((r: any) => [r.index_code, r.from_date, r.to_date]);

describe("单张快照", () => {
  it("只有一段：从 beginningdate 起至今", () => {
    snap("2026-09-22", "600000", "801780", "银行", "2021-12-13");
    buildIndustrySpans(db);
    expect(spans("600000")).toEqual([["801780", "2021-12-13", null]]);
  });

  it("**不会**凭空补出 beginningdate 之前那段 —— 那段是真的不知道", () => {
    snap("2026-09-22", "600000", "801780", "银行", "2021-12-13");
    buildIndustrySpans(db);
    expect(spans("600000").length).toBe(1);
    expect(spans("600000")[0][1]).toBe("2021-12-13");
  });
});

describe("两张快照", () => {
  it("行业没变：仍然一段 —— 采了两次不该把区间切碎", () => {
    snap("2026-09-15", "600000", "801780", "银行", "2021-12-13");
    snap("2026-09-22", "600000", "801780", "银行", "2021-12-13");
    buildIndustrySpans(db);
    expect(spans("600000")).toEqual([["801780", "2021-12-13", null]]);
  });

  it("行业变了：切成两段，且**变更日用新的 beginningdate**，不是快照日", () => {
    snap("2026-09-15", "300750", "801880", "汽车", "2021-12-13");
    // 下一张快照发现它挪到了电力设备，申万给的计入日是 09-18（在两次快照之间）
    snap("2026-09-22", "300750", "801730", "电力设备", "2026-09-18");
    buildIndustrySpans(db);
    expect(spans("300750")).toEqual([
      ["801880", "2021-12-13", "2026-09-18"],
      ["801730", "2026-09-18", null],
    ]);
  });

  it("周频快照的滞后只影响**发现**，不影响端点 —— 端点来自 beginningdate", () => {
    snap("2026-09-01", "300750", "801880", "汽车", "2021-12-13");
    snap("2026-09-22", "300750", "801730", "电力设备", "2026-09-03");
    buildIndustrySpans(db);
    // 09-03 换的，09-22 才发现，但区间端点仍是 09-03
    expect(spans("300750")[0][2]).toBe("2026-09-03");
  });
});

describe("多层与多票", () => {
  it("一级与三级各自成段，互不干扰", () => {
    snap("2026-09-22", "600000", "801780", "银行", "2021-12-13", 1);
    snap("2026-09-22", "600000", "857841", "国有大型银行Ⅲ", "2023-05-01", 3);
    buildIndustrySpans(db);
    expect(spans("600000", 1)).toEqual([["801780", "2021-12-13", null]]);
    expect(spans("600000", 3)).toEqual([["857841", "2023-05-01", null]]);
  });

  it("不传 codes 时处理全部票", () => {
    snap("2026-09-22", "600000", "801780", "银行", "2021-12-13");
    snap("2026-09-22", "000001", "801780", "银行", "2021-12-13");
    const r = buildIndustrySpans(db);
    expect(r.codes).toBe(2);
    expect(spans("000001").length).toBe(1);
  });
});

describe("重算", () => {
  it("幂等", () => {
    snap("2026-09-22", "600000", "801780", "银行", "2021-12-13");
    buildIndustrySpans(db);
    buildIndustrySpans(db);
    expect(spans("600000").length).toBe(1);
  });

  it("先删后插：旧的错区间不会留下 —— 它的主键可能恰好不被新行覆盖", () => {
    snap("2026-09-15", "300750", "801880", "汽车", "2021-12-13");
    buildIndustrySpans(db);
    expect(spans("300750")).toEqual([["801880", "2021-12-13", null]]);

    snap("2026-09-22", "300750", "801730", "电力设备", "2026-09-18");
    buildIndustrySpans(db);
    expect(spans("300750")).toEqual([
      ["801880", "2021-12-13", "2026-09-18"],
      ["801730", "2026-09-18", null],
    ]);
  });

  it("没有任何快照时不报错", () => {
    expect(() => buildIndustrySpans(db)).not.toThrow();
  });
});
