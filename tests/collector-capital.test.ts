import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb } from "@/lib/db";
import { runMigrations } from "@/lib/db/migrate";
import { collectMargin } from "@/lib/data/collectors/margin";
import { collectMutual } from "@/lib/data/collectors/mutual";
import { collectHolderChanges } from "@/lib/data/collectors/holder-change";

let dir: string, db: any;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "pt-cap-"));
  db = openDb(path.join(dir, "t.db"));
  runMigrations(db);
  const ins = db.prepare("INSERT INTO trading_calendar (date, is_open) VALUES (?, 1)");
  for (const d of ["2026-09-18", "2026-09-21", "2026-09-22"]) ins.run(d);
});
afterEach(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });

type Route = (url: string) => { ok: true; data: any[] } | { ok: false; error: string };
function stub(route: Route) {
  const calls: string[] = [];
  return {
    calls,
    client: {
      source: "eastmoney",
      breakerFor: () => ({ isOpen: () => false, record() {}, reset() {} }),
      async get(url: string) {
        calls.push(url);
        const r = route(decodeURIComponent(url));
        if (!r.ok) return { ok: false as const, error: r.error, latencyMs: 1 };
        return { ok: true as const, status: 200, latencyMs: 1,
          text: JSON.stringify({ success: true, result: { pages: 1, data: r.data } }) };
      },
    } as any,
  };
}
const gaps = () => db.prepare("SELECT date, kind, resolved_at FROM data_gap ORDER BY date").all();
const mkt = (d: string) => ({ DIM_DATE: `${d} 00:00:00`, RZYE: 100, RZYEZB: 2.6 });
const stk = (d: string, code: string) => ({ DATE: `${d} 00:00:00`, SCODE: code, RZYE: 10, RZYEZB: 5 });

describe("collectMargin", () => {
  it("汇总 + 按日个股，全部写入", async () => {
    const s = stub(u => u.includes("RZRQ_LSHJ")
      ? { ok: true, data: ["2026-09-18", "2026-09-21", "2026-09-22"].map(mkt) }
      : { ok: true, data: [stk(u.match(/DATE='([\d-]+)'/)![1], "600000"), stk(u.match(/DATE='([\d-]+)'/)![1], "000001")] });
    const r = await collectMargin(db, s.client, { from: "2026-09-18", to: "2026-09-22" });
    expect(r).toMatchObject({ marketRows: 3, stockDays: 3, stockRows: 6, missing: [] });
    expect(db.prepare("SELECT rzyezb FROM margin_market WHERE date='2026-09-22'").get().rzyezb).toBeCloseTo(0.026, 9);
  });

  it("汇总里还没有的日子 → 记可回补缺口，不去拉个股（T+1 才发布）", async () => {
    const s = stub(u => u.includes("RZRQ_LSHJ")
      ? { ok: true, data: ["2026-09-18", "2026-09-21"].map(mkt) }
      : { ok: true, data: [stk("2026-09-18", "600000")] });
    const r = await collectMargin(db, s.client, { from: "2026-09-18", to: "2026-09-22" });
    expect(r.missing).toEqual(["2026-09-22"]);
    expect(s.calls.filter(u => decodeURIComponent(u).includes("DATE='2026-09-22'"))).toHaveLength(0);
    expect(gaps()).toContainEqual(expect.objectContaining({ date: "2026-09-22", kind: "margin", resolved_at: null }));
  });

  it("汇总有、个股却 0 条 → 缺口，不是\"那天没人借钱\"", async () => {
    const s = stub(u => u.includes("RZRQ_LSHJ") ? { ok: true, data: [mkt("2026-09-22")] } : { ok: true, data: [] });
    const r = await collectMargin(db, s.client, { from: "2026-09-22", to: "2026-09-22" });
    expect(r.missing).toEqual(["2026-09-22"]);
    expect(gaps()).toHaveLength(1);
  });

  it("onlyMissing：已经齐的日子不重拉", async () => {
    db.prepare("INSERT INTO margin_stock (date, code, rzye) VALUES ('2026-09-18', '600000', 1)").run();
    const s = stub(u => u.includes("RZRQ_LSHJ")
      ? { ok: true, data: ["2026-09-18"].map(mkt) } : { ok: true, data: [stk("2026-09-18", "600000")] });
    const r = await collectMargin(db, s.client, { from: "2026-09-18", to: "2026-09-18" });
    expect(r.stockDays).toBe(0);
    expect(s.calls).toHaveLength(1);
  });

  it("补上之后销掉那天的缺口", async () => {
    const empty = stub(u => u.includes("RZRQ_LSHJ") ? { ok: true, data: [] } : { ok: true, data: [] });
    await collectMargin(db, empty.client, { from: "2026-09-22", to: "2026-09-22" });
    const full = stub(u => u.includes("RZRQ_LSHJ") ? { ok: true, data: [mkt("2026-09-22")] } : { ok: true, data: [stk("2026-09-22", "600000")] });
    await collectMargin(db, full.client, { from: "2026-09-22", to: "2026-09-22" });
    expect(gaps().every((g: any) => g.resolved_at !== null)).toBe(true);
  });

  it("熔断打开即收手，剩下的日子各记一条缺口但不再发请求", async () => {
    const s = stub(u => u.includes("RZRQ_LSHJ")
      ? { ok: true, data: ["2026-09-18", "2026-09-21", "2026-09-22"].map(mkt) }
      : { ok: false, error: "circuit open" });
    const r = await collectMargin(db, s.client, { from: "2026-09-18", to: "2026-09-22" });
    expect(r.missing).toEqual(["2026-09-18", "2026-09-21", "2026-09-22"]);
    expect(s.calls).toHaveLength(2);
  });

  it("汇总拉取失败 → 区间内每个交易日记缺口，个股一条都不拉", async () => {
    const s = stub(() => ({ ok: false, error: "timeout" }));
    const r = await collectMargin(db, s.client, { from: "2026-09-18", to: "2026-09-22" });
    expect(r.missing).toHaveLength(3);
    expect(s.calls).toHaveLength(1);
  });
});

describe("collectMutual", () => {
  const deal = (d: string) => ({ MUTUAL_TYPE: "005", TRADE_DATE: `${d} 00:00:00`, DEAL_AMT: 1, NET_DEAL_AMT: null });
  const t10 = (d: string, code: string) => ({ MUTUAL_TYPE: "001", TRADE_DATE: `${d} 00:00:00`, SECURITY_CODE: code, RANK: 1, DEAL_AMT: 1, MUTUAL_RATIO: 10 });

  it("写入成交与十大；十大按日整批替换（掉出名单的不能留着）", async () => {
    const a = stub(u => u.includes("DEAL_HISTORY") ? { ok: true, data: [deal("2026-09-22")] } : { ok: true, data: [t10("2026-09-22", "600000")] });
    await collectMutual(db, a.client, { from: "2026-09-22", to: "2026-09-22", date: "2026-09-23" });
    const b = stub(u => u.includes("DEAL_HISTORY") ? { ok: true, data: [deal("2026-09-22")] } : { ok: true, data: [t10("2026-09-22", "000001")] });
    await collectMutual(db, b.client, { from: "2026-09-22", to: "2026-09-22", date: "2026-09-23" });
    expect(db.prepare("SELECT code FROM mutual_top10").all()).toEqual([{ code: "000001" }]);
  });

  it("空区间（港股假期）合法，不记缺口", async () => {
    const s = stub(() => ({ ok: true, data: [] }));
    const r = await collectMutual(db, s.client, { from: "2026-10-01", to: "2026-10-07", date: "2026-10-08" });
    expect(r).toEqual({ dealRows: 0, top10Rows: 0 });
    expect(gaps()).toHaveLength(0);
  });

  it("拉取失败 → 可回补缺口；下次成功销掉", async () => {
    await collectMutual(db, stub(() => ({ ok: false, error: "timeout" })).client, { from: "2026-09-22", to: "2026-09-22", date: "2026-09-23" });
    expect(gaps()).toHaveLength(1);
    await collectMutual(db, stub(() => ({ ok: true, data: [] })).client, { from: "2026-09-22", to: "2026-09-22", date: "2026-09-24" });
    expect(gaps()[0].resolved_at).not.toBeNull();
  });
});

describe("collectHolderChanges", () => {
  const row = (dir: string, holder = "张三") => ({ SECURITY_CODE: "300592", HOLDER_NAME: holder, DIRECTION: dir,
    START_DATE: "2026-09-08", END_DATE: "2026-09-18", NOTICE_DATE: "2026-09-21", CHANGE_NUM: 160,
    CHANGE_FREE_RATIO: 0.47, HOLD_RATIO: 2.45, MARKET: "二级市场" });

  it("按主键 upsert：重拉同一窗口不重复", async () => {
    const s = () => stub(() => ({ ok: true, data: [row("减持")] })).client;
    await collectHolderChanges(db, s(), { from: "2026-09-20", to: "2026-09-23", date: "2026-09-23" });
    await collectHolderChanges(db, s(), { from: "2026-09-20", to: "2026-09-23", date: "2026-09-23" });
    const rs = db.prepare("SELECT change_free_ratio FROM holder_change").all();
    expect(rs).toHaveLength(1);
    expect(rs[0].change_free_ratio).toBeCloseTo(-0.0047, 12);
  });

  it("方向无法识别的行被丢弃时记缺口 —— 源口径变了要让人看见", async () => {
    const r = await collectHolderChanges(db, stub(() => ({ ok: true, data: [row("减持"), row("不明", "李四")] })).client,
      { from: "2026-09-20", to: "2026-09-23", date: "2026-09-23" });
    expect(r).toEqual({ written: 1, dropped: 1 });
    expect(gaps()).toContainEqual(expect.objectContaining({ kind: "holder_change", resolved_at: null }));
  });

  it("拉取失败 → 可回补缺口", async () => {
    const r = await collectHolderChanges(db, stub(() => ({ ok: false, error: "timeout" })).client,
      { from: "2026-09-20", to: "2026-09-23", date: "2026-09-23" });
    expect(r.written).toBe(0);
    expect(gaps()).toHaveLength(1);
  });
});
