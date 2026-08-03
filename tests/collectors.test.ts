import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb } from "@/lib/db";
import { runMigrations } from "@/lib/db/migrate";
import { collectMarketSnapshot } from "@/lib/data/collectors/market-snapshot";
import { collectZtPool } from "@/lib/data/collectors/cross-section";
import { collectWatchMinute } from "@/lib/data/collectors/watch-minute";
import { collectDaily } from "@/lib/data/collectors/daily";
import { collectLhb } from "@/lib/data/collectors/lhb";

let dir: string, db: any;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "pt-"));
  db = openDb(path.join(dir, "t.db"));
  runMigrations(db);
});
afterEach(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });

const gtimgLine = (code: string, name: string, price: string) => {
  const f = Array(88).fill("1");
  f[1] = name; f[2] = code; f[3] = price; f[4] = "12.0"; f[5] = "12.1";
  f[32] = "1.5"; f[33] = "13.2"; f[34] = "12.8"; f[38] = "2.2"; f[43] = "3.1";
  return `v_${code.startsWith("6") ? "sh" : "sz"}${code}="${f.join("~")}";`;
};

function clientReturning(text: string, ok = true) {
  return {
    source: "stub-source",
    breaker: { isOpen: () => false, record() {}, reset() {} } as any,
    async get() {
      return ok
        ? { ok: true as const, text, status: 200, latencyMs: 3 }
        : { ok: false as const, error: "empty response body", latencyMs: 3 };
    },
  };
}

describe("collectMarketSnapshot", () => {
  it("落库快照并返回写入条数", async () => {
    const text = [gtimgLine("601012", "隆基绿能", "13.0"),
                  gtimgLine("000001", "平安银行", "11.0")].join("\n");
    const r = await collectMarketSnapshot(db, clientReturning(text) as any, ["601012", "000001"]);
    expect(r.written).toBe(2);
    expect(r.failedBatches).toBe(0);
    const n = db.prepare("SELECT COUNT(*) n FROM quote_snapshot").get() as any;
    expect(n.n).toBe(2);
  });

  it("批次失败时记 data_gap，不抛穿也不静默", async () => {
    const r = await collectMarketSnapshot(db, clientReturning("", false) as any, ["601012"]);
    expect(r.written).toBe(0);
    expect(r.failedBatches).toBe(1);
    const gaps = db.prepare("SELECT * FROM data_gap").all();
    expect(gaps.length).toBe(1);
    expect((gaps[0] as any).recoverable).toBe(0);   // 快照不可回补
    expect((gaps[0] as any).kind).toBe("quote_snapshot");
  });

  it("超过 60 只自动分批", async () => {
    const codes = Array.from({ length: 130 }, (_, i) => String(600000 + i));
    const text = codes.map(c => gtimgLine(c, "x", "1.0")).join("\n");
    const r = await collectMarketSnapshot(db, clientReturning(text) as any, codes);
    // 3 批 (60+60+10)，每批 stub 都返回全部 130 行
    expect(r.failedBatches).toBe(0);
    expect(r.written).toBeGreaterThan(0);
  });
});

describe("collectZtPool", () => {
  it("落库涨停池", async () => {
    const payload = JSON.stringify({
      data: { qdate: 20260731, tc: 1, pool: [
        { c: "000593", n: "德龙汇能", lbc: 1, fund: 1000, zbc: 0,
          fbt: 93005, lbt: 145900, hybk: "燃气", hs: 1.81 }] },
    });
    const n = await collectZtPool(db, clientReturning(payload) as any, "20260731");
    expect(n).toBe(1);
    const row = db.prepare("SELECT * FROM zt_pool").get() as any;
    expect(row.code).toBe("000593");
    expect(row.date).toBe("2026-07-31");
    expect(row.first_seal_ts).toBe("09:30:05");
  });

  it("涨停池抓取失败记不可回补 gap 并抛错", async () => {
    await expect(collectZtPool(db, clientReturning("", false) as any, "20260731"))
      .rejects.toThrow();
    const gaps = db.prepare("SELECT * FROM data_gap WHERE kind='zt_pool'").all();
    expect(gaps.length).toBe(1);
    expect((gaps[0] as any).recoverable).toBe(0);
    expect((gaps[0] as any).date).toBe("2026-07-31");
  });
});

describe("collectWatchMinute", () => {
  it("落库分钟线", async () => {
    const bars = JSON.stringify([
      { day: "2026-07-31 14:55:00", open: "1", high: "2", low: "0.5", close: "1.5", volume: "100" },
    ]);
    const r = await collectWatchMinute(db, clientReturning(bars) as any, ["601012"], 5);
    expect(r.written).toBe(1);
    const row = db.prepare("SELECT * FROM kline_min").get() as any;
    expect(row.period).toBe("m5");
    expect(row.code).toBe("601012");
  });

  it("单只失败不影响其他，且记不可回补 gap", async () => {
    const r = await collectWatchMinute(db, clientReturning("", false) as any, ["601012", "000001"], 5);
    expect(r.failed).toEqual(["601012", "000001"]);
    const gaps = db.prepare("SELECT COUNT(*) n FROM data_gap WHERE recoverable = 0").get() as any;
    expect(gaps.n).toBe(2);
  });
});

describe("collectDaily", () => {
  it("落库日线", async () => {
    const bars = JSON.stringify([
      { day: "2026-07-31", open: "1", high: "2", low: "0.5", close: "1.5", volume: "100" },
    ]);
    const r = await collectDaily(db, clientReturning(bars) as any, ["601012"], 10);
    expect(r.written).toBe(1);
    const row = db.prepare("SELECT * FROM kline_daily").get() as any;
    expect(row.date).toBe("2026-07-31");
    expect(row.adj_factor).toBe(1.0);
  });

  it("日线失败记的是可回补 gap", async () => {
    await collectDaily(db, clientReturning("", false) as any, ["601012"], 10);
    const g = db.prepare("SELECT * FROM data_gap").get() as any;
    expect(g.recoverable).toBe(1);
  });
});

describe("collectLhb", () => {
  it("落库龙虎榜并解决既有 gap", async () => {
    const payload = JSON.stringify({
      result: { pages: 1, data: [{
        SECURITY_CODE: "601012", SECURITY_NAME_ABBR: "隆基绿能",
        BILLBOARD_NET_AMT: 100, BILLBOARD_BUY_AMT: 200, BILLBOARD_SELL_AMT: 100,
        EXPLAIN: "机构专用", D1_CLOSE_ADJCHRATE: 1.2,
        D5_CLOSE_ADJCHRATE: null, D10_CLOSE_ADJCHRATE: null }] },
    });
    const n = await collectLhb(db, clientReturning(payload) as any, "2026-07-31");
    expect(n).toBe(1);
    const row = db.prepare("SELECT * FROM lhb").get() as any;
    expect(row.d1_chg).toBe(1.2);
    expect(row.d10_chg).toBe(null);
  });

  it("龙虎榜失败记的是可回补 gap", async () => {
    await expect(collectLhb(db, clientReturning("", false) as any, "2026-07-31"))
      .rejects.toThrow();
    const g = db.prepare("SELECT * FROM data_gap").get() as any;
    expect(g.recoverable).toBe(1);
  });
});
