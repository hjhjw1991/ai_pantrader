import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { watchPool, MINUTE_POOL_MAX } from "@/lib/data/watch-pool";
import { syncIntradayWatch } from "@/lib/data/intraday-watch";

/**
 * 盘中分钟线采哪些票。
 *
 * 这一组测试守的是一件事：**采的票必须跟判断有关**。旧版取 security 表前 50 只，
 * 实测采到的是 000001~000059 那一批（含 PT金田A、国华退、新都退），而自选、
 * 持仓、今日候选一只都不在里面 —— 分钟线不可回补，采错就是白采一天。
 */

let dir: string;
let db: Database.Database;
const D = "2026-10-09";

function addWatch(code: string): void {
  db.prepare(
    `INSERT OR REPLACE INTO watchpool (code, name, account, added_at, active) VALUES (?,?,?,?,1)`
  ).run(code, `名${code}`, "hj-main", `${D} 08:00:00.000`);
}
function addHeld(code: string, qty: number): void {
  db.prepare(`INSERT OR IGNORE INTO account (id,name,type) VALUES ('a1','主账户','主')`).run();
  db.prepare(
    `INSERT OR REPLACE INTO position (account_id,code,cost,qty,open_date) VALUES ('a1',?,10,?,?)`
  ).run(code, qty, D);
}
function addPlan(code: string, date: string): void {
  db.prepare(
    `INSERT INTO prediction (id, ts, phase, code, strategy_id, action, eval_horizon, valid_until, advisor_influenced)
     VALUES (?, ?, '盘前', ?, 's1', '买入', 5, ?, 0)`
  ).run(`${code}-${date}`, `${date} 09:00:00.000`, code, `${date} 15:00:00.000`);
}

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "pantrader-pool-"));
  db = new Database(path.join(dir, "t.db"));
  runMigrations(db);
  db.pragma("foreign_keys = ON");
});

afterAll(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** 盘中还在候选池里的票。走同步函数建，测的就是真实写法路径 */
function addLive(code: string, date: string = D): void {
  syncIntradayWatch(db, { date, ts: `${date} 09:40:00.000`, candidates: [{ code }] });
}

beforeEach(() => {
  db.prepare("DELETE FROM watchpool").run();
  db.prepare("DELETE FROM position").run();
  db.prepare("DELETE FROM prediction").run();
  db.prepare("DELETE FROM intraday_watch").run();
});

describe("分钟线池 = 自选 ∪ 持仓 ∪ 盘中候选 ∪ 今日计划点名的票", () => {
  it("什么都没有 → 空池，不去采一堆无关的票兜底", () => {
    const p = watchPool(db, D);
    expect(p.codes).toEqual([]);
    expect(p).toMatchObject({ fromWatch: 0, fromHeld: 0, fromIntraday: 0, fromPlan: 0, truncated: 0 });
  });

  it("自选进池：人点名要盯的票必须有分钟线", () => {
    addWatch("600667");
    addWatch("002882");
    const p = watchPool(db, D);
    expect(p.codes).toEqual(["600667", "002882"]);
    expect(p.fromWatch).toBe(2);
  });

  it("持仓进池：离场判断要看盘中形状", () => {
    addHeld("688126", 100);
    expect(watchPool(db, D).codes).toEqual(["688126"]);
  });

  it("今日计划点名的票进池：系统今天要盯它（候选与持仓动作）", () => {
    addPlan("300750", D);
    const p = watchPool(db, D);
    expect(p.codes).toEqual(["300750"]);
    expect(p.fromPlan).toBe(1);
  });

  it("只认当天的计划：昨天的候选不该占今天的额度", () => {
    addPlan("300750", "2026-10-08");
    addPlan("002594", D);
    expect(watchPool(db, D).codes).toEqual(["002594"]);
  });

  it("盘中冒出来的候选进池：10:40 才符合条件也得有分钟线", () => {
    addLive("300750");
    const p = watchPool(db, D);
    expect(p.codes).toEqual(["300750"]);
    expect(p.fromIntraday).toBe(1);
  });

  it("已经掉出候选的不再采（不满足条件就停）", () => {
    addLive("300750");
    syncIntradayWatch(db, { date: D, ts: `${D} 09:45:00.000`, candidates: [] });
    const p = watchPool(db, D);
    expect(p.codes).toEqual([]);
    expect(p.fromIntraday).toBe(0);
  });

  it("盘中候选只认当天：昨天盯过的不占今天的额度", () => {
    addLive("300750", "2026-10-08");
    addLive("002594");
    expect(watchPool(db, D).codes).toEqual(["002594"]);
  });

  it("四路合并去重，自选排在最前（人点名的先拿到额度）", () => {
    addWatch("600667");
    addHeld("600667", 100);      // 自选里也有
    addHeld("688126", 100);
    // 一次同步给两只：每次同步都是"这一轮还在池里的全部"，分开调会把前一只判成掉出
    syncIntradayWatch(db, {
      date: D, ts: `${D} 09:40:00.000`,
      candidates: [{ code: "688126" }, { code: "300750" }],   // 688126 持仓里也有
    });
    addPlan("300750", D);        // 盘中候选里也有
    addPlan("601127", D);
    const p = watchPool(db, D);
    expect(p.codes).toEqual(["600667", "688126", "300750", "601127"]);
    expect(p.fromWatch).toBe(1);
    expect(p.fromHeld).toBe(2);
    expect(p.fromIntraday).toBe(2);
    expect(p.fromPlan).toBe(2);
  });

  it("清仓后的票不再占额度（qty=0 不算持仓，计数里也不该有它）", () => {
    addHeld("688126", 0);
    const p = watchPool(db, D);
    expect(p.codes).toEqual([]);
    expect(p.fromHeld).toBe(0);
  });

  it("移出观察池的票不进池（active=0）", () => {
    addWatch("600667");
    db.prepare("UPDATE watchpool SET active = 0 WHERE code = ?").run("600667");
    expect(watchPool(db, D).codes).toEqual([]);
  });

  it("超上限截断，并报出截掉了多少", () => {
    for (let i = 0; i < MINUTE_POOL_MAX + 12; i++) {
      addWatch(String(600000 + i));
    }
    const p = watchPool(db, D);
    expect(p.codes).toHaveLength(MINUTE_POOL_MAX);
    expect(p.truncated).toBe(12);
    expect(p.fromWatch).toBe(MINUTE_POOL_MAX + 12);
  });

  it("上限可收紧（测试/临时降频用）", () => {
    addWatch("600001");
    addWatch("600002");
    addWatch("600003");
    expect(watchPool(db, D, 2).codes).toEqual(["600001", "600002"]);
    expect(watchPool(db, D, 2).truncated).toBe(1);
  });
});
