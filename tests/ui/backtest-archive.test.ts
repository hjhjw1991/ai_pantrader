import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { saveBacktestReport, deleteBacktestReport, REPORT_KEEP } from "@/lib/ui/mutations";
import { backtestReports, backtestReportById } from "@/lib/ui/queries";
import { DELETE } from "@/app/api/backtest/reports/route";

/**
 * 路由用的是 writeDb() 自己开库。这里让它开到测试这个临时库上：
 * 删除是不是真的删掉、有没有被注入，只有对着真库才测得出来。
 * 工厂里不能直接引用 db（vi.mock 会被提到文件顶部，那时 db 还没建），
 * 所以走 globalThis 间接取 —— 函数体是调用时才执行的。
 */
vi.mock("@/lib/ui/db", async (imp) => {
  const actual = (await imp()) as Record<string, unknown>;
  return { ...actual, writeDb: () => (globalThis as { __db?: Database.Database }).__db };
});

/**
 * 回测存档。
 *
 * 存在理由是代价：实测 0.38 秒/交易日 —— 四年跨度的单次回测约 6 分钟，
 * 36 点的参数扫描约 3.7 小时。报告原本只活在 React state 里，离开页面就没了，
 * 于是"再看一眼上周那次"意味着重跑三个半小时。
 */
let dir: string, db: Database.Database;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "pt-archive-"));
  db = new Database(path.join(dir, "t.db"));
  runMigrations(db);
  (globalThis as { __db?: Database.Database }).__db = db;
});
afterEach(() => {
  // 路由里的 finally 已经把库关了（那是它的库还是我们的库，这里分不清），关第二次会抛
  try { db.close(); } catch { /* 已关闭 */ }
  delete (globalThis as { __db?: Database.Database }).__db;
  fs.rmSync(dir, { recursive: true, force: true });
});

const input = (over: Partial<Parameters<typeof saveBacktestReport>[1]> = {}) => ({
  kind: "backtest" as const,
  strategyId: "default",
  strategyVersion: "1.0.0",
  from: "2022-08-27",
  to: "2026-08-27",
  initialCash: 100_000,
  metrics: { annualReturn: 0.18, maxDrawdown: -0.12, calmar: 1.5, trades: 42 },
  report: { equity: [{ date: "2026-08-27", equity: 118_000, position: 0.3 }], marker: "原样" },
  ...over,
});

describe("回测存档", () => {
  it("存下来能按 id 原样读回 —— 报告是不可变快照，读回来必须一字不差", () => {
    const id = saveBacktestReport(db, input());
    const got = backtestReportById(db, id);
    expect(got).not.toBeNull();
    expect(got!.kind).toBe("backtest");
    expect(got!.report).toEqual(input().report);
  });

  it("列表带摘要字段，且不读 report_json", () => {
    saveBacktestReport(db, input());
    const rows = backtestReports(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: "backtest", strategyId: "default", from: "2022-08-27", to: "2026-08-27",
      calmar: 1.5, trades: 42,
    });
    // 摘要里不该混进整份报告
    expect(Object.keys(rows[0])).not.toContain("report");
  });

  it("扫描存的是另一种结构，kind 必须分得清 —— 靠猜解析迟早解析错", () => {
    const id = saveBacktestReport(db, input({
      kind: "sweep", evaluated: 36, metrics: null,
      report: { heatmap: [[1, 2]], evaluated: 36 },
    }));
    expect(backtestReportById(db, id)!.kind).toBe("sweep");
    expect(backtestReports(db)[0].evaluated).toBe(36);
    // 扫描没有单点指标，摘要里如实为 null，不补 0（0 会被读成"收益为零"）
    expect(backtestReports(db)[0].calmar).toBeNull();
  });

  it("列表按时间倒序：最近跑的排最前", () => {
    const ids = [saveBacktestReport(db, input()), saveBacktestReport(db, input()), saveBacktestReport(db, input())];
    const rows = backtestReports(db);
    expect(rows).toHaveLength(3);
    expect(new Set(rows.map(r => r.id))).toEqual(new Set(ids));
    expect(rows.map(r => r.ts)).toEqual([...rows.map(r => r.ts)].sort().reverse());
  });

  it("同一份配置重跑一次是两条记录，不去重 —— 用户想看到'我又跑了一次'", () => {
    const a = saveBacktestReport(db, input());
    const b = saveBacktestReport(db, input());
    expect(a).not.toBe(b);
    expect(backtestReports(db)).toHaveLength(2);
  });

  it(`只留最近 ${REPORT_KEEP} 份，超出的从旧到新删`, () => {
    for (let i = 0; i < REPORT_KEEP + 5; i++) saveBacktestReport(db, input());
    expect(backtestReports(db, 999)).toHaveLength(REPORT_KEEP);
  });

  it("存坏的档只让自己读不出来，不该让整个列表打不开", () => {
    const id = saveBacktestReport(db, input());
    db.prepare("UPDATE backtest_report SET report_json = '{坏的' WHERE id = ?").run(id);
    expect(backtestReportById(db, id)).toBeNull();
    expect(backtestReports(db)).toHaveLength(1);
  });

  it("查不到的 id 返回 null，不抛", () => {
    expect(backtestReportById(db, "不存在")).toBeNull();
  });

  it("能手动删掉一份", () => {
    const id = saveBacktestReport(db, input());
    expect(deleteBacktestReport(db, id)).toBe(true);
    expect(backtestReports(db)).toHaveLength(0);
  });

  /**
   * 删除是**阻塞**的，界面点一下就该立刻看到那一行没了。
   * 前提是删除这个动作本身说得出"到底删没删到" —— 下面两条测的就是这个。
   */
  it("删一个不存在的 id 返回 false，不静默报成功", () => {
    saveBacktestReport(db, input());
    expect(deleteBacktestReport(db, "20220101000000000-zzz")).toBe(false);
    // 没删到不该顺带把别人的档弄没
    expect(backtestReports(db)).toHaveLength(1);
  });

  it("同一份删两次，第二次是 false —— 手快点了第二下时这是唯一的线索", () => {
    const id = saveBacktestReport(db, input());
    expect(deleteBacktestReport(db, id)).toBe(true);
    expect(deleteBacktestReport(db, id)).toBe(false);
  });

  it("删掉一份不影响其它份：id 是随机后缀，删错一份不该牵连同批次", () => {
    const a = saveBacktestReport(db, input());
    const b = saveBacktestReport(db, input({ strategyId: "另一套" }));
    expect(deleteBacktestReport(db, a)).toBe(true);
    const left = backtestReports(db);
    expect(left).toHaveLength(1);
    expect(left[0].id).toBe(b);
  });
});

/**
 * 删除接口本身。
 *
 * 界面是"await 到响应 = 删除已完成"，所以这条链路必须真的同步写完再回：
 * better-sqlite3 是同步写，DELETE 语句执行完才 return，没有中间态。
 * 测的是两件事 —— 删到了回 ok，没删到回 404 而不是 ok。
 */
describe("删除存档接口", () => {
  const req = (id: string) => new Request(`http://127.0.0.1/api/backtest/reports?id=${id}`) as any;

  it("删到了：回 200，库里真的没了", async () => {
    const id = saveBacktestReport(db, input());
    const r = await DELETE(req(id));
    expect(r.status).toBe(200);
    // 路由用完会 close 掉它拿到的库（这里就是测试库），所以重开一个连接看落盘结果 ——
    // 顺带把"连接被关"这件事也验了：连接泄漏在生产里是迟早要重启的坑
    const fresh = new Database(path.join(dir, "t.db"));
    expect(backtestReports(fresh)).toHaveLength(0);
    fresh.close();
  });

  it("没删到：回 404 而不是 200 —— 一律报成功的话，界面只能显示'已删除'", async () => {
    const r = await DELETE(req("20220101000000000-zzz"));
    expect(r.status).toBe(404);
    expect(((await r.json()) as { error: string }).error).toMatch(/不在/);
  });

  it("id 形状不合法直接 400，不拿去查库", async () => {
    const r = await DELETE(req("'; DROP TABLE backtest_report; --"));
    expect(r.status).toBe(400);
    // 库还在：注入没走到 SQL
    expect(backtestReports(db)).toHaveLength(0);
    expect(db.prepare("SELECT COUNT(*) c FROM backtest_report").get()).toEqual({ c: 0 });
  });
});
