import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb } from "@/lib/db";
import { runMigrations } from "@/lib/db/migrate";
import {
  pushNotification, recentNotifications, notificationsPage, countNotifications,
  markRead, diffAndNotify, readSignalState, maxNotificationId,
  connectionBackfill, parseReadUpToId,
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
  ts: "2026-08-05 10:00:00.000", phase: "盘中", strategyId: "t", strategyName: "t",
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

  it("markRead 之后 read_at 被回填，客户端据此判未读", () => {
    pushNotification(db, { kind: "k", severity: "info", title: "1" });
    const all = recentNotifications(db);
    expect(all[0].readAt).toBeNull();
    markRead(db, all[0].id);
    const after = recentNotifications(db);
    expect(after[0].readAt).not.toBeNull();
  });

  it("maxNotificationId 返回当前最大 id，空表为 0", () => {
    expect(maxNotificationId(db)).toBe(0);
    pushNotification(db, { kind: "k", severity: "info", title: "1" });
    pushNotification(db, { kind: "k", severity: "info", title: "2" });
    expect(maxNotificationId(db)).toBe(2);
  });

  it("waterMark 语义：id > maxNotificationId 的才是连接后新通知", () => {
    pushNotification(db, { kind: "k", severity: "info", title: "历史" });
    const wm = maxNotificationId(db);
    // 水位之内的，再查一次应该查不到（recentNotifications 用 > 而非 >=）
    expect(recentNotifications(db, wm)).toHaveLength(0);
    pushNotification(db, { kind: "k", severity: "info", title: "新" });
    const inc = recentNotifications(db, wm);
    expect(inc).toHaveLength(1);
    expect(inc[0].title).toBe("新");
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

describe("通知历史翻页", () => {
  const seed = (n: number) => {
    for (let i = 1; i <= n; i++) pushNotification(db, { kind: "k", severity: "info", title: `第${i}条` });
  };

  it("before=0 是第一页，倒序返回", () => {
    seed(12);
    const p1 = notificationsPage(db, 0, 10);
    expect(p1).toHaveLength(10);
    expect(p1[0].title).toBe("第12条");
    expect(p1.map(n => n.id)).toEqual([...p1].sort((a, b) => b.id - a.id).map(n => n.id));
  });

  it("多取一条用来判断还有没有 —— 恰好整页时不误报", () => {
    seed(10);
    // 前端传 limit+1：总数正好等于 limit 时，多出来的一条不存在
    expect(notificationsPage(db, 0, 11)).toHaveLength(10);
    expect(notificationsPage(db, 0, 11).length > 10).toBe(false);
  });

  it("第二页以第一页最小 id 为游标，不重不漏", () => {
    seed(15);
    const p1 = notificationsPage(db, 0, 10);
    const cursor = p1[p1.length - 1].id;
    const p2 = notificationsPage(db, cursor, 10);
    expect(p2).toHaveLength(5);
    const overlap = p2.filter(n => p1.some(m => m.id === n.id));
    expect(overlap).toHaveLength(0);          // 不与第一页重复
    expect(new Set([...p1, ...p2].map(n => n.id)).size).toBe(15);   // 合起来正好是全部
  });

  it("翻页期间插入新通知不会污染后续页", () => {
    seed(15);
    const p1 = notificationsPage(db, 0, 10);
    const cursor = p1[p1.length - 1].id;
    pushNotification(db, { kind: "k", severity: "critical", title: "翻页中新来的" });
    const p2 = notificationsPage(db, cursor, 10);
    expect(p2.map(n => n.title)).not.toContain("翻页中新来的");   // 新来的是最新的，不属于更旧的页
    expect(notificationsPage(db, 0, 1)[0].title).toBe("翻页中新来的");
  });

  it("countNotifications 是全表条数，且随去重失败不增长", () => {
    seed(5);
    expect(countNotifications(db)).toBe(5);
    pushNotification(db, { kind: "k", severity: "info", title: "重了", dedupeKey: "dup" });
    expect(countNotifications(db)).toBe(6);
    // 重复 dedupeKey 被拒，总数不该动
    pushNotification(db, { kind: "k", severity: "info", title: "重了2", dedupeKey: "dup" });
    expect(countNotifications(db)).toBe(6);
  });

  it("空表不炸", () => {
    expect(notificationsPage(db, 0, 10)).toEqual([]);
    expect(countNotifications(db)).toBe(0);
  });
});

describe("connectionBackfill：历史回填与水位（修复：历史不再走 notify 被当新消息重弹）", () => {
  it("返回最新的 limit 条作为历史，水位 = max(sinceId, 当前最大 id)", () => {
    for (let i = 1; i <= 5; i++) pushNotification(db, { kind: "k", severity: "info", title: `n${i}` });
    const feed = connectionBackfill(db, 0, 50);
    expect(feed.history.map(n => n.title)).toEqual(["n5", "n4", "n3", "n2", "n1"]);
    expect(feed.waterMark).toBe(5);
  });

  it("sinceId 参与水位：客户端已持有的不回退", () => {
    for (let i = 1; i <= 5; i++) pushNotification(db, { kind: "k", severity: "info", title: `n${i}` });
    const feed = connectionBackfill(db, 3, 50);
    expect(feed.waterMark).toBe(5); // max(3, 5)
  });

  it("水位之内的不再走 notify：recentNotifications(waterMark) 为空", () => {
    for (let i = 1; i <= 5; i++) pushNotification(db, { kind: "k", severity: "info", title: `n${i}` });
    const { waterMark } = connectionBackfill(db, 0, 50);
    expect(recentNotifications(db, waterMark)).toHaveLength(0);
  });

  it("水位之后新产生的才走 notify：连接后插入的被 recentNotifications(waterMark) 捞到", () => {
    for (let i = 1; i <= 3; i++) pushNotification(db, { kind: "k", severity: "info", title: `old${i}` });
    const { waterMark } = connectionBackfill(db, 0, 50); // 此刻水位 = 3
    pushNotification(db, { kind: "k", severity: "warn", title: "new" }); // 连接后新通知
    const live = recentNotifications(db, waterMark);
    expect(live).toHaveLength(1);
    expect(live[0].title).toBe("new");
  });
});

describe("parseReadUpToId：标记已读入参校验", () => {
  it("合法非负整数原样返回", () => {
    expect(parseReadUpToId(0)).toBe(0);
    expect(parseReadUpToId(1)).toBe(1);
    expect(parseReadUpToId(42)).toBe(42);
  });
  it("null / undefined / 负数 / 小数 / 字符串 一律判非法", () => {
    expect(parseReadUpToId(null)).toBeNull();
    expect(parseReadUpToId(undefined)).toBeNull();
    expect(parseReadUpToId(-1)).toBeNull();
    expect(parseReadUpToId(1.5)).toBeNull();
    expect(parseReadUpToId("5")).toBeNull();
    expect(parseReadUpToId([])).toBeNull();
  });
});
