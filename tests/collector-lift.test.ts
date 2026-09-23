import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb } from "@/lib/db";
import { runMigrations } from "@/lib/db/migrate";
import { collectLiftSchedule } from "@/lib/data/collectors/lift";

let dir: string, db: any;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "pt-lift-"));
  db = openDb(path.join(dir, "t.db"));
  runMigrations(db);
});
afterEach(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });

const rows = () => db.prepare("SELECT * FROM lift_schedule ORDER BY code, free_date").all();

function stub(pages: any[][], opt: { fail?: boolean } = {}) {
  let i = 0;
  return {
    source: "eastmoney",
    breakerFor: () => ({ isOpen: () => false, record() {}, reset() {} }),
    async get() {
      if (opt.fail) return { ok: false as const, error: "timeout", latencyMs: 1 };
      const data = pages[i] ?? [];
      i++;
      return {
        ok: true as const, status: 200, latencyMs: 1,
        text: JSON.stringify({ success: true, result: { pages: pages.length, data } }),
      };
    },
  };
}

const row = (code: string, d: string, ratio = 0.05, type = "首发原股东限售股份") => ({
  SECURITY_CODE: code, FREE_DATE: `${d} 00:00:00`, CURRENT_FREE_SHARES: 1000,
  LIFT_MARKET_CAP: 5000, FREE_RATIO: ratio, TOTAL_RATIO: ratio * 0.9, FREE_SHARES_TYPE: type,
});

describe("collectLiftSchedule", () => {
  it("写入解禁日历，单位换算成股/元", async () => {
    const r = await collectLiftSchedule(db, stub([[row("600000", "2026-10-15")]]) as any,
      { from: "2026-01-01", to: "2027-12-31", date: "2026-09-23" });
    expect(r.written).toBe(1);
    expect(rows()[0]).toMatchObject({ code: "600000", free_date: "2026-10-15", free_shares: 1e7, free_ratio: 0.05 });
  });

  it("同一天两批不同类型的限售股分开存", async () => {
    await collectLiftSchedule(db, stub([[
      row("600000", "2026-10-15", 0.03, "首发原股东限售股份"),
      row("600000", "2026-10-15", 0.02, "定向增发机构配售股份"),
    ]]) as any, { from: "2026-01-01", to: "2027-12-31", date: "2026-09-23" });
    expect(rows().length).toBe(2);
  });

  it("重拉时窗口内先删后插 —— 东财撤掉的解禁不能残留在表里", async () => {
    const w = { from: "2026-01-01", to: "2027-12-31", date: "2026-09-23" };
    await collectLiftSchedule(db, stub([[row("600000", "2026-10-15"), row("000001", "2026-11-01")]]) as any, w);
    await collectLiftSchedule(db, stub([[row("600000", "2026-10-15")]]) as any, w);
    expect(rows().map((x: any) => x.code)).toEqual(["600000"]);
  });

  it("窗口外的历史不被误删", async () => {
    await collectLiftSchedule(db, stub([[row("600000", "2020-05-01")]]) as any,
      { from: "2020-01-01", to: "2020-12-31", date: "2026-09-23" });
    await collectLiftSchedule(db, stub([[row("600000", "2026-10-15")]]) as any,
      { from: "2026-01-01", to: "2027-12-31", date: "2026-09-23" });
    expect(rows().map((x: any) => x.free_date)).toEqual(["2020-05-01", "2026-10-15"]);
  });

  it("请求失败：记可回补缺口，且**一行都不删** —— 拉失败时清空窗口，等于宣称这段时间没有解禁", async () => {
    const w = { from: "2026-01-01", to: "2027-12-31", date: "2026-09-23" };
    await collectLiftSchedule(db, stub([[row("600000", "2026-10-15")]]) as any, w);
    const r = await collectLiftSchedule(db, stub([], { fail: true }) as any, w);
    expect(r.written).toBe(0);
    expect(rows().length).toBe(1);
    const g: any = db.prepare("SELECT * FROM data_gap WHERE kind='lift_schedule' AND resolved_at IS NULL").get();
    expect(g.recoverable).toBe(1);
  });

  it("宽窗口拿到 0 条也记缺口 —— 全市场两年内零解禁不可能，多半是限流", async () => {
    await collectLiftSchedule(db, stub([[]]) as any,
      { from: "2026-01-01", to: "2027-12-31", date: "2026-09-23" });
    expect(db.prepare("SELECT COUNT(*) n FROM data_gap WHERE kind='lift_schedule' AND resolved_at IS NULL").get().n).toBe(1);
  });
});
