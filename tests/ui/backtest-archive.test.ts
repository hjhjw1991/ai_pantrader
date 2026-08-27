import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { saveBacktestReport, deleteBacktestReport, REPORT_KEEP } from "@/lib/ui/mutations";
import { backtestReports, backtestReportById } from "@/lib/ui/queries";

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
});
afterEach(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });

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
    deleteBacktestReport(db, id);
    expect(backtestReports(db)).toHaveLength(0);
  });
});
