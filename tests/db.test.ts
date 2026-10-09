import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb } from "@/lib/db";
import { runMigrations } from "@/lib/db/migrate";

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "pt-")); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

describe("db", () => {
  it("openDb 创建文件并启用 WAL", () => {
    const db = openDb(path.join(dir, "t.db"));
    expect(db.pragma("journal_mode", { simple: true })).toBe("wal");
    db.close();
  });

  it("runMigrations 建出全部 M0 表", () => {
    const db = openDb(path.join(dir, "t.db"));
    runMigrations(db);
    const names = db.prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all().map((r: any) => r.name);
    for (const t of ["kline_daily", "kline_min", "quote_snapshot", "zt_pool",
                     "dt_pool", "sector_rank", "lhb", "lhb_seat", "macro", "security",
                     "trading_calendar", "data_gap", "source_health"]) {
      expect(names).toContain(t);
    }
    db.close();
  });

  it("lhb 主键含 change_type —— 少了它同票多条上榜原因会被折叠", () => {
    const db = openDb(path.join(dir, "t.db"));
    runMigrations(db);
    const pk = db.prepare("PRAGMA table_info(lhb)").all()
      .filter((r: any) => r.pk > 0)
      .sort((a: any, b: any) => a.pk - b.pk)
      .map((r: any) => r.name);
    expect(pk).toEqual(["date", "code", "change_type"]);
    db.close();
  });

  it("每张数据表都在 .ptbak 清单里 —— 漏一张就是备份里静默少一张", async () => {
    const { BAK_TABLES, EPHEMERAL_TABLES } = await import("@/lib/backup/export");
    const db = openDb(path.join(dir, "t.db"));
    runMigrations(db);
    const names = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
    ).all().map((r: any) => r.name)
      // _migrations 是迁移账本、app_meta 是本机配置，都不属于可搬迁的历史数据
      .filter((n: string) => !n.startsWith("_") && n !== "app_meta");
    // 每张表要么备份、要么显式声明为易失，不允许"没人管"的第三种状态
    for (const t of names) {
      const covered = BAK_TABLES.includes(t) || EPHEMERAL_TABLES.includes(t);
      expect(covered, `表 ${t} 既不在 BAK_TABLES 也不在 EPHEMERAL_TABLES`).toBe(true);
    }
    // 两份清单不能重叠，否则语义矛盾
    for (const t of EPHEMERAL_TABLES) expect(BAK_TABLES).not.toContain(t);
    db.close();
  });

  it("runMigrations 幂等，二次执行不重复应用", () => {
    const db = openDb(path.join(dir, "t.db"));
    const first = runMigrations(db);
    const second = runMigrations(db);
    expect(first.length).toBeGreaterThan(0);
    expect(second.length).toBe(0);
    db.close();
  });

  /**
   * 028：shadow_pred.decided_at / entry_type、prediction.entry_type。
   * 升级路径要单独测 —— 新库上 UPDATE 回填一行都碰不到，回填写错了新库测不出来。
   */
  it("028 在新库上建出 decided_at / entry_type，entry_type 只收 低吸 / 突破", () => {
    const db = openDb(path.join(dir, "t.db"));
    runMigrations(db);
    const cols = (t: string) => db.prepare(`PRAGMA table_info(${t})`).all().map((r: any) => r.name);
    expect(cols("shadow_pred")).toEqual(expect.arrayContaining(["decided_at", "entry_type"]));
    expect(cols("prediction")).toContain("entry_type");
    expect(() => db.prepare(
      `INSERT INTO prediction (id, ts, phase, code, strategy_id, action, eval_horizon, valid_until, entry_type)
       VALUES ('x', '2026-08-04 09:15:00', '盘前', '600000', 's', '买入', 5, '2026-08-11', '追涨')`
    ).run()).toThrow(/CHECK/);
    db.close();
  });

  it("028 升级老库：live 的 decided_at 回填 created_at，replay 回填基准日 15:05；entry_type 一律 低吸", () => {
    const db = openDb(path.join(dir, "t.db"));
    // 先只跑到 027，模拟升级前的老库
    const migDir = path.join(process.cwd(), "lib/db/migrations");
    db.exec("CREATE TABLE _migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)");
    for (const f of fs.readdirSync(migDir).filter(f => f.endsWith(".sql") && f < "028").sort()) {
      db.exec(fs.readFileSync(path.join(migDir, f), "utf8"));
      db.prepare("INSERT INTO _migrations (name, applied_at) VALUES (?, 'x')").run(f);
    }
    const ins = db.prepare(
      `INSERT INTO shadow_pred (id, variant_id, source, base_date, decided_on, code, account, trigger_px, size, gear, strategy_id, slot_lock, created_at)
       VALUES (?, 'a', ?, '2026-09-01', ?, '600000', '卫星', 10, 0.1, '中性', 's', '{}', ?)`
    );
    ins.run("L", "live", "2026-09-02", "2026-09-02 11:00:03.120");
    ins.run("R", "replay", "2026-09-01", "2026-10-05 20:00:00.000");
    db.prepare(
      `INSERT INTO prediction (id, ts, phase, code, strategy_id, action, eval_horizon, valid_until)
       VALUES ('P', '2026-08-04 09:15:00', '盘前', '600000', 's', '买入', 5, '2026-08-11')`
    ).run();

    expect(runMigrations(db).filter(f => f.startsWith("028"))).toHaveLength(1);
    const rows = Object.fromEntries((db.prepare("SELECT id, decided_at, entry_type FROM shadow_pred").all() as any[])
      .map(r => [r.id, r]));
    expect(rows.L).toMatchObject({ decided_at: "2026-09-02 11:00:03.120", entry_type: "低吸" });
    expect(rows.R).toMatchObject({ decided_at: "2026-09-01 15:05:00", entry_type: "低吸" });
    expect((db.prepare("SELECT entry_type FROM prediction").get() as any).entry_type).toBe("低吸");
    db.close();
  });
});
