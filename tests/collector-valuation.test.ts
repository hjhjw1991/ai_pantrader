import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb } from "@/lib/db";
import { runMigrations } from "@/lib/db/migrate";
import { collectValuation } from "@/lib/data/collectors/valuation";

let dir: string, db: any;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "pt-val-"));
  db = openDb(path.join(dir, "t.db"));
  runMigrations(db);
});
afterEach(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });

const rows = () =>
  db.prepare("SELECT code, date, pe, pb, mktcap FROM valuation_daily ORDER BY code").all();

function stub(pages: any[][], fail = false) {
  let i = 0;
  return {
    source: "eastmoney",
    breakerFor: () => ({ isOpen: () => false, record() {}, reset() {} }),
    breakers: { for: () => ({ isOpen: () => false, record() {}, reset() {} }), allOpen: () => false },
    async get() {
      if (fail) return { ok: false as const, error: "empty response body", latencyMs: 1 };
      const diff = pages[i] ?? [];
      i++;
      return {
        ok: true as const,
        text: JSON.stringify({ data: { total: pages.flat().length, diff } }),
        status: 200, latencyMs: 1,
      };
    },
  };
}

describe("collectValuation", () => {
  it("按日期写入 PE/PB/市值", async () => {
    const c = stub([[{ f12: "000001", f9: 4.38, f23: 0.49, f20: 2.2e11, f21: 2.2e11 }]]);
    const r = await collectValuation(db, c as any, { date: "2026-09-23", pageSize: 1 });

    expect(r.written).toBe(1);
    expect(rows()[0]).toMatchObject({ code: "000001", date: "2026-09-23", pe: 4.38, pb: 0.49 });
  });

  it("PE/PB/市值全为空的行不写 —— 退市与 PT 票没有估值，写一行全 null 只是噪音", async () => {
    const c = stub([[
      { f12: "000001", f9: 4.38, f23: 0.49 },
      { f12: "000003", f9: "-", f23: "-", f20: "-", f21: "-" },
    ]]);
    const r = await collectValuation(db, c as any, { date: "2026-09-23", pageSize: 2 });
    expect(r.written).toBe(1);
    expect(rows().map((x: any) => x.code)).toEqual(["000001"]);
  });

  it("亏损股的负 PE 照样入库 —— 它是真实读数，过滤掉等于把亏损伪装成没数据", async () => {
    const c = stub([[{ f12: "000002", f9: -1.64, f23: 0.48 }]]);
    await collectValuation(db, c as any, { date: "2026-09-23", pageSize: 1 });
    expect(rows()[0].pe).toBe(-1.64);
  });

  it("请求失败记缺口，且标成**不可回补** —— 估值是当日现场，错过这一刻就永久没有", async () => {
    const c = stub([], true);
    const r = await collectValuation(db, c as any,
      { date: "2026-09-23", rounds: 1, backoffMs: 0, retries: 0 });

    expect(r.written).toBe(0);
    const g: any = db.prepare(
      "SELECT * FROM data_gap WHERE kind='valuation' AND resolved_at IS NULL").get();
    expect(g).toBeTruthy();
    expect(g.recoverable).toBe(0);
  });

  it("一条都没拿到也要记缺口，不许静默成功 —— 空响应是限流的典型表现", async () => {
    const c = stub([[]]);
    await collectValuation(db, c as any, { date: "2026-09-23" });
    expect(db.prepare(
      "SELECT COUNT(*) n FROM data_gap WHERE kind='valuation' AND resolved_at IS NULL").get().n
    ).toBe(1);
  });

  it("同日重跑幂等", async () => {
    const mk = () => stub([[{ f12: "000001", f9: 4.38, f23: 0.49 }]]);
    await collectValuation(db, mk() as any, { date: "2026-09-23", pageSize: 1 });
    await collectValuation(db, mk() as any, { date: "2026-09-23", pageSize: 1 });
    expect(rows().length).toBe(1);
  });

  it("成功后销掉当天的缺口", async () => {
    await collectValuation(db, stub([], true) as any,
      { date: "2026-09-23", rounds: 1, backoffMs: 0, retries: 0 });
    await collectValuation(db, stub([[{ f12: "000001", f9: 4.38, f23: 0.49 }]]) as any,
      { date: "2026-09-23", pageSize: 1 });
    expect(db.prepare(
      "SELECT COUNT(*) n FROM data_gap WHERE kind='valuation' AND resolved_at IS NULL").get().n
    ).toBe(0);
  });
});
