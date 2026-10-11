import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { liveIntradayWatch, syncIntradayWatch } from "@/lib/data/intraday-watch";

/**
 * 盘中临时盯的票：**这一轮还在候选池里就盯，掉出去就停**。
 *
 * 这一组测试守的是三条边界：
 *   1. 掉出候选必须立刻停采（人说的是"直到不满足条件"，不是"盯一整天"）
 *   2. 候选算不出来 ≠ 候选为空 —— 后者是"今天没得买"，前者是"不知道"，
 *      把不知道当成空，一次引擎报错就清空名单，那段分钟线永久没了
 *   3. 掉出又回来要能复活，且不能当成"新进"重复计数
 */

let dir: string;
let db: Database.Database;
const D = "2026-10-12";

function sync(ts: string, codes: string[], extra: Record<string, any> = {}): any {
  return syncIntradayWatch(db, {
    date: D,
    ts,
    candidates: codes.map(c => ({ code: c, name: `名${c}`, thesis: `理由${c}`, score: 1.5, ...extra })),
  });
}
function row(code: string): any {
  return db.prepare(`SELECT * FROM intraday_watch WHERE date = ? AND code = ?`).get(D, code);
}

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "pantrader-iwatch-"));
  db = new Database(path.join(dir, "t.db"));
  runMigrations(db);
});

afterAll(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  db.prepare("DELETE FROM intraday_watch").run();
});

describe("进池：这一轮还在候选池里的票", () => {
  it("新候选进池，并记下当时凭什么盯它", () => {
    const r = sync("2026-10-12 09:40:00.000", ["600667"]);
    expect(r).toMatchObject({ seen: 1, entered: 1, revived: 0, dropped: 0 });
    expect(liveIntradayWatch(db, D)).toEqual(["600667"]);
    expect(row("600667")).toMatchObject({
      name: "名600667", thesis: "理由600667", score: 1.5, rounds: 1, active: 1,
    });
    expect(row("600667").drop_ts).toBeNull();
  });

  it("连着几轮都在：只记一次新进，轮数累加", () => {
    sync("2026-10-12 09:40:00.000", ["600667"]);
    const r = sync("2026-10-12 09:45:00.000", ["600667"]);
    expect(r).toMatchObject({ seen: 1, entered: 0, revived: 0, dropped: 0 });
    expect(row("600667").rounds).toBe(2);
    expect(row("600667").last_ts).toBe("2026-10-12 09:45:00.000");
  });

  it("同一次里重复的代码只算一只（卡片不该出重复票，出了也不能数两遍）", () => {
    const r = sync("2026-10-12 09:40:00.000", ["600667", "600667"]);
    expect(r.seen).toBe(1);
    expect(row("600667").rounds).toBe(1);
  });
});

describe("掉出：不满足进候选池的条件就停采", () => {
  it("这一轮不在候选里 → 立刻停（active=0，留下掉出的时刻）", () => {
    sync("2026-10-12 09:40:00.000", ["600667", "002882"]);
    const r = sync("2026-10-12 09:45:00.000", ["600667"]);
    expect(r).toMatchObject({ seen: 1, entered: 0, dropped: 1 });
    expect(liveIntradayWatch(db, D)).toEqual(["600667"]);
    expect(row("002882")).toMatchObject({ active: 0, drop_ts: "2026-10-12 09:45:00.000" });
  });

  it("掉出后行留着：进了多久、什么时候掉的，是复盘要看的", () => {
    sync("2026-10-12 09:40:00.000", ["600667"]);
    sync("2026-10-12 09:45:00.000", []);
    expect(row("600667")).toMatchObject({ first_ts: "2026-10-12 09:40:00.000", rounds: 1 });
    expect(liveIntradayWatch(db, D)).toEqual([]);
  });

  it("已经掉出的票不会再被数一次 dropped（重复同步不该重复记账）", () => {
    sync("2026-10-12 09:40:00.000", ["600667"]);
    sync("2026-10-12 09:45:00.000", []);
    const r = sync("2026-10-12 09:50:00.000", []);
    expect(r.dropped).toBe(0);
  });
});

describe("复活：掉出去又回来", () => {
  it("算 revived，不算新进，轮数接着累加", () => {
    sync("2026-10-12 09:40:00.000", ["600667"]);
    sync("2026-10-12 09:45:00.000", []);
    const r = sync("2026-10-12 09:50:00.000", ["600667"]);
    expect(r).toMatchObject({ entered: 0, revived: 1, dropped: 0 });
    expect(row("600667")).toMatchObject({ active: 1, rounds: 2 });
    expect(row("600667").drop_ts).toBeNull();
  });
});

describe("候选算不出来 ≠ 候选为空", () => {
  it("null 时一个字都不改：一次引擎报错不该清空整张盯守名单", () => {
    sync("2026-10-12 09:40:00.000", ["600667", "002882"]);
    const r = syncIntradayWatch(db, { date: D, ts: "2026-10-12 09:45:00.000", candidates: null });
    expect(r).toBeNull();
    // 同一轮进来的按代码序：排序键是 first_ts，再并列就得有个确定的先后
    expect(liveIntradayWatch(db, D)).toEqual(["002882", "600667"]);
    expect(row("600667").last_ts).toBe("2026-10-12 09:40:00.000");
  });
});

describe("只认当天", () => {
  it("昨天盯过的票不带到今天（今天要重新满足一次条件）", () => {
    sync("2026-10-12 09:40:00.000", ["600667"]);
    expect(liveIntradayWatch(db, D)).toEqual(["600667"]);
    expect(liveIntradayWatch(db, "2026-10-13")).toEqual([]);
  });

  it("新的一天同一只票算新进，轮数从头计", () => {
    sync("2026-10-12 09:40:00.000", ["600667"]);
    const r = syncIntradayWatch(db, {
      date: "2026-10-13", ts: "2026-10-13 09:40:00.000",
      candidates: [{ code: "600667" }],
    });
    expect(r).toMatchObject({ entered: 1, seen: 1 });
    expect(
      db.prepare(`SELECT rounds FROM intraday_watch WHERE date='2026-10-13' AND code='600667'`).get()
    ).toMatchObject({ rounds: 1 });
  });
});

describe("排序：先进先采", () => {
  it("被截断时砍的是最后才冒出来的那批", () => {
    sync("2026-10-12 09:40:00.000", ["600001", "600002"]);
    sync("2026-10-12 09:45:00.000", ["600001", "600002", "600003"]);
    expect(liveIntradayWatch(db, D)).toEqual(["600001", "600002", "600003"]);
  });
});
