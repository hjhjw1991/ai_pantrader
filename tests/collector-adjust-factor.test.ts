import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb } from "@/lib/db";
import { runMigrations } from "@/lib/db/migrate";
import { collectAdjustFactors } from "@/lib/data/collectors/adjust-factor";

let dir: string, db: any;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "pt-adj-"));
  db = openDb(path.join(dir, "t.db"));
  runMigrations(db);
});
afterEach(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });

const ins = (code: string, date: string, c: number) =>
  db.prepare(
    `INSERT OR REPLACE INTO kline_daily (code, date, o, h, l, c, vol, amount, adj_factor)
     VALUES (?, ?, ?, ?, ?, ?, 1, 1, 1.0)`
  ).run(code, date, c, c, c, c);

const factorsOf = (code: string) =>
  db.prepare("SELECT date, adj_factor FROM kline_daily WHERE code=? ORDER BY date").all(code)
    .map((r: any) => [r.date, Number(r.adj_factor.toFixed(6))]);

function payload(rows: Array<[string, string]>) {
  return `var sh600000hfq={"total":${rows.length},"data":[` +
    rows.map(([d, f]) => `{"d":"${d}", "f":"${f}"}`).join(",") + `]}\n/* tail */`;
}

function stub(byCode: Record<string, string | "FAIL" | "404">) {
  return {
    source: "sina",
    breakerFor: () => ({ isOpen: () => false, record() {}, reset() {} }),
    async get(url: string) {
      const m = /company\/[a-z]{2}(\d+)\//.exec(url);
      const code = m === null ? "" : m[1];
      const p = byCode[code];
      if (p === "404") {
        return { ok: false as const, error: "http 404", status: 404, latencyMs: 1 };
      }
      if (p === undefined || p === "FAIL") {
        return { ok: false as const, error: "empty response body", latencyMs: 1 };
      }
      return { ok: true as const, text: p, status: 200, latencyMs: 1 };
    },
  };
}

describe("collectAdjustFactors", () => {
  it("按生效区间回填 adj_factor —— 因子从除权日当天起生效", async () => {
    for (const [d, c] of [["2026-07-14", 9.2], ["2026-07-15", 9.31], ["2026-07-16", 8.85], ["2026-07-17", 8.87]] as const) {
      ins("600000", d as string, c as number);
    }
    const p = payload([["1900-01-01", "1"], ["2026-07-16", "1.0472"]]);
    const r = await collectAdjustFactors(db, stub({ "600000": p }) as any, ["600000"]);

    expect(r.updated).toBe(1);
    expect(factorsOf("600000")).toEqual([
      ["2026-07-14", 1], ["2026-07-15", 1], ["2026-07-16", 1.0472], ["2026-07-17", 1.0472],
    ]);
  });

  it("没有除权记录：因子保持 1，且**不记缺口** —— 那是合法状态不是采集失败", async () => {
    ins("000001", "2026-07-16", 12);
    const empty = `var sz000001hfq={"total":0,"data":[]}`;
    const r = await collectAdjustFactors(db, stub({ "000001": empty }) as any, ["000001"]);

    expect(r.noAdjust).toEqual(["000001"]);
    expect(r.failed).toEqual([]);
    expect(factorsOf("000001")).toEqual([["2026-07-16", 1]]);
    expect(db.prepare("SELECT COUNT(*) n FROM data_gap").get().n).toBe(0);
  });

  it("请求失败：记缺口，且一行都不改 —— 改一半比不改更糟，序列会在中间断层", async () => {
    ins("600000", "2026-07-15", 9.31);
    ins("600000", "2026-07-16", 8.85);
    const r = await collectAdjustFactors(db, stub({ "600000": "FAIL" }) as any, ["600000"]);

    expect(r.failed.map(f => f.code)).toEqual(["600000"]);
    expect(factorsOf("600000")).toEqual([["2026-07-15", 1], ["2026-07-16", 1]]);
    expect(db.prepare(
      "SELECT COUNT(*) n FROM data_gap WHERE kind LIKE 'adj_factor%' AND resolved_at IS NULL"
    ).get().n).toBe(1);
  });

  it("只动自己那只票", async () => {
    ins("600000", "2026-07-16", 8.85);
    ins("000001", "2026-07-16", 12);
    await collectAdjustFactors(db, stub({
      "600000": payload([["1900-01-01", "1"], ["2026-07-16", "2"]]),
    }) as any, ["600000"]);

    expect(factorsOf("600000")).toEqual([["2026-07-16", 2]]);
    expect(factorsOf("000001")).toEqual([["2026-07-16", 1]]);
  });

  it("重跑幂等", async () => {
    ins("600000", "2026-07-16", 8.85);
    const p = payload([["1900-01-01", "1"], ["2026-07-16", "1.5"]]);
    await collectAdjustFactors(db, stub({ "600000": p }) as any, ["600000"]);
    await collectAdjustFactors(db, stub({ "600000": p }) as any, ["600000"]);
    expect(factorsOf("600000")).toEqual([["2026-07-16", 1.5]]);
  });

  it("成功后销掉该票之前的缺口 —— 不销的话回测里整个交易日会被跳过", async () => {
    ins("600000", "2026-07-16", 8.85);
    await collectAdjustFactors(db, stub({ "600000": "FAIL" }) as any, ["600000"]);
    await collectAdjustFactors(db, stub({
      "600000": payload([["1900-01-01", "1"]]),
    }) as any, ["600000"]);
    expect(db.prepare(
      "SELECT COUNT(*) n FROM data_gap WHERE kind LIKE 'adj_factor%' AND resolved_at IS NULL"
    ).get().n).toBe(0);
  });
});

describe("源不覆盖的票（北交所）", () => {
  const unresolved = () =>
    db.prepare(
      "SELECT kind FROM data_gap WHERE kind LIKE 'adj_factor%' AND resolved_at IS NULL"
    ).all().map((r: any) => r.kind);

  it("404 归入 unsupported，**不逐只记缺口** —— 343 条永远补不掉的记录会把真事故淹掉", async () => {
    ins("920001", "2026-07-16", 10);
    ins("920002", "2026-07-16", 11);
    const r = await collectAdjustFactors(
      db, stub({ "920001": "404", "920002": "404" }) as any, ["920001", "920002"]);

    expect(r.unsupported).toEqual(["920001", "920002"]);
    expect(r.failed).toEqual([]);
    expect(unresolved()).not.toContain("adj_factor:920001");
  });

  it("但要留**一条**聚合缺口，且是不可回补的 —— 这是源的能力缺口，不是今晚没采到", async () => {
    ins("920001", "2026-07-16", 10);
    await collectAdjustFactors(db, stub({ "920001": "404" }) as any, ["920001"]);

    const g: any = db.prepare(
      "SELECT * FROM data_gap WHERE kind='adj_factor:unsupported'").get();
    expect(g).toBeTruthy();
    expect(g.recoverable).toBe(0);
    expect(g.reason).toMatch(/1/);
  });

  it("这些票的因子保持 1.0，但那**不等于**没有分红 —— 只是这个源查不到", async () => {
    ins("920001", "2026-07-16", 10);
    await collectAdjustFactors(db, stub({ "920001": "404" }) as any, ["920001"]);
    expect(factorsOf("920001")).toEqual([["2026-07-16", 1]]);
  });

  it("全部覆盖时不记那条聚合缺口", async () => {
    ins("600000", "2026-07-16", 8.85);
    await collectAdjustFactors(db, stub({
      "600000": payload([["1900-01-01", "1"]]),
    }) as any, ["600000"]);
    expect(unresolved()).toEqual([]);
  });
});

describe("跨日期销账", () => {
  it("成功后要销掉**所有日期**上该票的缺口 —— 因子一次重写整段历史，不是只修今天", async () => {
    ins("600000", "2026-07-16", 8.85);
    // 模拟昨天失败留下的缺口
    db.prepare(
      `INSERT INTO data_gap (date, source, kind, reason, recoverable, detected_at)
       VALUES ('2026-09-22', 'sina', 'adj_factor:600000', '昨天失败了', 1, '2026-09-22 22:00:00.000')`
    ).run();

    await collectAdjustFactors(db, stub({
      "600000": payload([["1900-01-01", "1"]]),
    }) as any, ["600000"], { date: "2026-09-23" });

    expect(db.prepare(
      "SELECT COUNT(*) n FROM data_gap WHERE kind='adj_factor:600000' AND resolved_at IS NULL"
    ).get().n).toBe(0);
  });

  it("源不覆盖时同样跨日期销掉逐只缺口 —— 它们已经被聚合成一条了", async () => {
    ins("920001", "2026-07-16", 10);
    db.prepare(
      `INSERT INTO data_gap (date, source, kind, reason, recoverable, detected_at)
       VALUES ('2026-09-22', 'sina', 'adj_factor:920001', '昨天 404', 1, '2026-09-22 22:00:00.000')`
    ).run();

    await collectAdjustFactors(db, stub({ "920001": "404" }) as any, ["920001"], { date: "2026-09-23" });

    expect(db.prepare(
      "SELECT COUNT(*) n FROM data_gap WHERE kind='adj_factor:920001' AND resolved_at IS NULL"
    ).get().n).toBe(0);
  });
});
