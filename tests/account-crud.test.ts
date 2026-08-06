import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb } from "@/lib/db";
import { runMigrations } from "@/lib/db/migrate";
import {
  upsertAccount, deleteAccount, setAccountActive, accountRefs, accountExists,
} from "@/lib/ui/mutations";
import { accounts } from "@/lib/ui/queries";

let dir: string, db: any;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "pt-acc-"));
  db = openDb(path.join(dir, "t.db"));
  runMigrations(db);
});
afterEach(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });

const addTrade = (accountId: string, code = "600519") =>
  db.prepare(
    `INSERT INTO trade (id, ts, account_id, code, side, px, qty, fee, source)
     VALUES (?, '2026-08-05 10:00:00.000', ?, ?, 'buy', 10, 100, 0, 'manual')`
  ).run(`t-${accountId}-${code}`, accountId, code);

const addPosition = (accountId: string, code = "600519") =>
  db.prepare(
    `INSERT INTO position (account_id, code, qty, cost, open_date)
     VALUES (?, ?, 100, 10, '2026-08-05')`
  ).run(accountId, code);

describe("账户不预置", () => {
  it("迁移完账户表是空的 —— 预置几个账户再让用户删，等于把假设塞进用户的账本", () => {
    expect(accounts(db)).toEqual([]);
  });
});

describe("新增 / 改", () => {
  it("upsert 建账户，默认启用并记 created_at", () => {
    upsertAccount(db, { id: "main", name: "主账户", type: "长线" });
    const r = accounts(db);
    expect(r.length).toBe(1);
    expect(r[0]).toMatchObject({ id: "main", name: "主账户", type: "长线", active: true });
    expect(db.prepare("SELECT created_at FROM account WHERE id='main'").get().created_at)
      .toMatch(/^\d{4}-\d{2}-\d{2} /);
  });

  it("类型标签是自由文本，不是枚举 —— 账户体系不该改代码才能扩展", () => {
    upsertAccount(db, { id: "a", name: "A", type: "打板" });
    upsertAccount(db, { id: "b", name: "B", type: "网格套利" });
    expect(accounts(db).map(a => a.type).sort()).toEqual(["打板", "网格套利"]);
  });

  it("再次 upsert 同 id = 改名，且会恢复被停用的账户", () => {
    upsertAccount(db, { id: "main", name: "旧名", type: "长线" });
    setAccountActive(db, "main", false);
    upsertAccount(db, { id: "main", name: "新名", type: "长线" });
    const r = accounts(db)[0];
    expect(r.name).toBe("新名");
    expect(r.active).toBe(true);
  });
});

describe("引用计数", () => {
  it("持仓 / 成交 / 委托分别计数", () => {
    upsertAccount(db, { id: "main", name: "主", type: "长线" });
    addPosition("main", "600519");
    addTrade("main", "600519");
    addTrade("main", "000001");
    expect(accountRefs(db, "main")).toEqual({ positions: 1, trades: 2, orders: 0 });
  });

  it("accounts() 一次带出引用数 —— 界面要靠它决定按钮写'删除'还是'停用'", () => {
    upsertAccount(db, { id: "used", name: "有账", type: "长线" });
    upsertAccount(db, { id: "fresh", name: "空的", type: "长线" });
    addTrade("used");
    const m = new Map(accounts(db).map(a => [a.id, a]));
    expect(m.get("used")!.refs.trades).toBe(1);
    expect(m.get("fresh")!.refs).toEqual({ positions: 0, trades: 0, orders: 0 });
  });
});

describe("删除", () => {
  it("没有台账引用 → 物理删，不留空壳", () => {
    upsertAccount(db, { id: "typo", name: "建错了", type: "长线" });
    const r = deleteAccount(db, "typo");
    expect(r.mode).toBe("hard");
    expect(accountExists(db, "typo")).toBe(false);
    expect(accounts(db)).toEqual([]);
  });

  it("有成交挂着 → 只停用，行还在，历史归属不丢", () => {
    upsertAccount(db, { id: "main", name: "主", type: "长线" });
    addTrade("main");
    const r = deleteAccount(db, "main");
    expect(r.mode).toBe("soft");
    expect(r.refs.trades).toBe(1);
    // 行必须还在：硬删会让 trade.account_id 指向不存在的账户，
    // 按账户分组的统计会凭空少一组且没有提示
    expect(accountExists(db, "main")).toBe(true);
    expect(accounts(db)[0].active).toBe(false);
    expect(db.prepare("SELECT account_id FROM trade").get().account_id).toBe("main");
  });

  it("有持仓挂着 → 同样只停用", () => {
    upsertAccount(db, { id: "main", name: "主", type: "长线" });
    addPosition("main");
    expect(deleteAccount(db, "main").mode).toBe("soft");
    expect(accountExists(db, "main")).toBe(true);
  });

  it("返回的 note 说清实际发生了什么 —— 点了删除却只是停用，这件事必须说出来", () => {
    upsertAccount(db, { id: "main", name: "主", type: "长线" });
    addTrade("main");
    expect(deleteAccount(db, "main").note).toMatch(/已停用而非删除/);
    upsertAccount(db, { id: "fresh", name: "空", type: "长线" });
    expect(deleteAccount(db, "fresh").note).toMatch(/彻底删除/);
  });
});

describe("停用 / 恢复", () => {
  it("停用后仍然列出来 —— 藏起来用户会以为记录丢了", () => {
    upsertAccount(db, { id: "old", name: "旧", type: "长线" });
    setAccountActive(db, "old", false);
    const r = accounts(db);
    expect(r.length).toBe(1);
    expect(r[0].active).toBe(false);
  });

  it("启用的排在前面", () => {
    upsertAccount(db, { id: "b", name: "B", type: "x" });
    upsertAccount(db, { id: "a", name: "A", type: "x" });
    setAccountActive(db, "a", false);
    expect(accounts(db).map(x => x.id)).toEqual(["b", "a"]);
  });

  it("恢复", () => {
    upsertAccount(db, { id: "a", name: "A", type: "x" });
    setAccountActive(db, "a", false);
    setAccountActive(db, "a", true);
    expect(accounts(db)[0].active).toBe(true);
  });

  it("对不存在的 id 返回 false，调用方好回 404", () => {
    expect(setAccountActive(db, "ghost", false)).toBe(false);
  });
});
