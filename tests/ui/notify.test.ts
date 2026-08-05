import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb } from "@/lib/db";
import { runMigrations } from "@/lib/db/migrate";
import {
  pushNotification, recentNotifications, markRead, diffAndNotify, readSignalState,
} from "@/lib/ui/notify";
import type { SignalCard, Candidate } from "@/lib/contracts";

let dir: string, db: any;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "pt-notify-"));
  db = openDb(path.join(dir, "t.db"));
  runMigrations(db);
});
afterEach(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });

const cand = (code: string, action: Candidate["action"] = "买入"): Candidate => ({
  code, name: `票${code}`, action, account: "a",
  triggerPx: 10, stopPx: 9.5, size: 0.1, thesis: "测试逻辑",
  passedFilters: [], factors: [], score: 1,
});

const card = (gear: any, cands: Candidate[]): SignalCard => ({
  ts: "2026-08-05 10:00:00.000", phase: "盘中", strategyId: "t",
  env: { gear, targetPosition: 0.4, reasons: [], factors: [], lowConfidenceFactors: [] },
  candidates: cands, holdings: [], warnings: [], advisorInfluenced: false,
});

describe("通知去重", () => {
  it("同一 dedupeKey 只留一条", () => {
    expect(pushNotification(db, { kind: "k", severity: "warn", title: "a", dedupeKey: "x" })).toBe(true);
    expect(pushNotification(db, { kind: "k", severity: "warn", title: "b", dedupeKey: "x" })).toBe(false);
    expect(recentNotifications(db)).toHaveLength(1);
  });

  it("没有 dedupeKey 的可以重复写", () => {
    pushNotification(db, { kind: "k", severity: "info", title: "a" });
    pushNotification(db, { kind: "k", severity: "info", title: "a" });
    expect(recentNotifications(db)).toHaveLength(2);
  });

  it("sinceId 之后的增量读取 —— SSE 靠它不重复推", () => {
    pushNotification(db, { kind: "k", severity: "info", title: "1" });
    const first = recentNotifications(db);
    pushNotification(db, { kind: "k", severity: "info", title: "2" });
    const inc = recentNotifications(db, first[0].id);
    expect(inc).toHaveLength(1);
    expect(inc[0].title).toBe("2");
  });

  it("markRead 只标未读", () => {
    pushNotification(db, { kind: "k", severity: "info", title: "1" });
    pushNotification(db, { kind: "k", severity: "info", title: "2" });
    const all = recentNotifications(db);
    expect(markRead(db, all[0].id)).toBe(2);
    expect(markRead(db, all[0].id)).toBe(0);
  });
});

describe("diffAndNotify：只有需要人做动作的才响", () => {
  it("首次运行不通知 —— 那不是变化，只是第一次看到", () => {
    diffAndNotify(db, card("中性", [cand("600000")]), 0);
    expect(recentNotifications(db)).toHaveLength(0);
    expect(readSignalState(db)?.gear).toBe("中性");
  });

  it("档位切换要通知，切防守是 critical（防守=空仓）", () => {
    diffAndNotify(db, card("进攻", []), 0);
    diffAndNotify(db, card("防守", []), 0);
    const n = recentNotifications(db);
    expect(n).toHaveLength(1);
    expect(n[0].kind).toBe("gear_change");
    expect(n[0].severity).toBe("critical");
    expect(n[0].body).toMatch(/空仓/);
  });

  it("档位没变就不通知 —— 每分钟刷新一次不能每次都响", () => {
    diffAndNotify(db, card("中性", []), 0);
    diffAndNotify(db, card("中性", []), 0);
    diffAndNotify(db, card("中性", []), 0);
    expect(recentNotifications(db)).toHaveLength(0);
  });

  it("新增买入候选要通知", () => {
    diffAndNotify(db, card("中性", []), 0);
    diffAndNotify(db, card("中性", [cand("600519")]), 0);
    const n = recentNotifications(db);
    expect(n.some(x => x.kind === "new_candidate" && x.title.includes("600519"))).toBe(true);
  });

  it("新增的只是观察类不通知 —— 观察不要求动作", () => {
    diffAndNotify(db, card("中性", []), 0);
    diffAndNotify(db, card("中性", [cand("600519", "观察")]), 0);
    expect(recentNotifications(db).filter(n => n.kind === "new_candidate")).toHaveLength(0);
  });

  it("同一只票同一动作重复出现只响一次", () => {
    diffAndNotify(db, card("中性", []), 0);
    diffAndNotify(db, card("中性", [cand("600519")]), 0);
    // 候选消失又回来，当天不该再响
    diffAndNotify(db, card("中性", []), 0);
    diffAndNotify(db, card("中性", [cand("600519")]), 0);
    expect(recentNotifications(db).filter(n => n.kind === "new_candidate")).toHaveLength(1);
  });

  it("硬线告警数变多 → critical", () => {
    diffAndNotify(db, card("中性", []), 0);
    diffAndNotify(db, card("中性", []), 2);
    const n = recentNotifications(db).find(x => x.kind === "hard_line")!;
    expect(n.severity).toBe("critical");
  });

  it("硬线告警数减少不通知 —— 那是好事，不需要打扰", () => {
    diffAndNotify(db, card("中性", []), 3);
    diffAndNotify(db, card("中性", []), 1);
    expect(recentNotifications(db).filter(n => n.kind === "hard_line")).toHaveLength(0);
  });
});
