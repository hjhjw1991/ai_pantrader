import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb } from "@/lib/db";
import { runMigrations } from "@/lib/db/migrate";
import { deriveSecurityMeta, seedStObservation, SINA_MAX_BARS } from "@/lib/data/security-meta";

let dir: string, db: any;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "pt-"));
  db = openDb(path.join(dir, "t.db"));
  runMigrations(db);
});
afterEach(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });

function addSecurity(code: string, name: string) {
  db.prepare("INSERT INTO security (code, name, board) VALUES (?, ?, '主板')").run(code, name);
}
function addBars(code: string, n: number, startDay = 1) {
  const ins = db.prepare(
    "INSERT INTO kline_daily (code, date, o, h, l, c, vol) VALUES (?, ?, 1, 1, 1, 1, 1)");
  for (let i = 0; i < n; i++) {
    const d = new Date(Date.UTC(2020, 0, startDay + i)).toISOString().slice(0, 10);
    ins.run(code, d);
  }
}

describe("deriveSecurityMeta", () => {
  it("序列未触顶时，第一根 bar 就是上市日", () => {
    addSecurity("920258", "N聚仁");
    addBars("920258", 1);
    const r = deriveSecurityMeta(db);
    expect(r.listDateResolved).toBe(1);
    const s = db.prepare("SELECT * FROM security WHERE code='920258'").get() as any;
    expect(s.list_date).toBe("2020-01-01");
    expect(s.first_bar_date).toBe("2020-01-01");
    expect(s.bar_count).toBe(1);
  });

  it("序列触顶 1023 根时 list_date 留 NULL —— 真上市日更早，猜一个比留空危险", () => {
    addSecurity("601012", "隆基绿能");
    addBars("601012", SINA_MAX_BARS);
    const r = deriveSecurityMeta(db);
    expect(r.windowCapped).toBe(1);
    expect(r.listDateResolved).toBe(0);
    const s = db.prepare("SELECT * FROM security WHERE code='601012'").get() as any;
    expect(s.list_date).toBe(null);
    // 下界仍然记下来，供消费方区分"窗口之前上市"和"确切上市日"
    expect(s.first_bar_date).toBe("2020-01-01");
    expect(s.bar_count).toBe(SINA_MAX_BARS);
  });

  it("不能按日期判断是否截断 —— 长期停牌票 1023 根能回溯到很早", () => {
    // 停牌票：根数触顶但首根日期极早；老票：根数触顶日期较晚。
    // 若按"市场最早日期+N天"判断，会把前者误判成真上市日
    addSecurity("000001", "老停牌票");
    addBars("000001", SINA_MAX_BARS, 1);
    addSecurity("600000", "正常老票");
    addBars("600000", SINA_MAX_BARS, 500);
    deriveSecurityMeta(db);
    const a = db.prepare("SELECT list_date FROM security WHERE code='000001'").get() as any;
    const b = db.prepare("SELECT list_date FROM security WHERE code='600000'").get() as any;
    expect(a.list_date).toBe(null);
    expect(b.list_date).toBe(null);
  });

  it("重复运行不改变已定的 list_date", () => {
    addSecurity("920258", "N聚仁");
    addBars("920258", 1);
    deriveSecurityMeta(db);
    deriveSecurityMeta(db);
    const s = db.prepare("SELECT list_date FROM security WHERE code='920258'").get() as any;
    expect(s.list_date).toBe("2020-01-01");
  });
});

describe("seedStObservation", () => {
  it("当前名称带 ST 的播种观测起点", () => {
    addSecurity("920575", "*ST康乐");
    addSecurity("601012", "隆基绿能");
    const n = seedStObservation(db);
    expect(n).toBe(1);
    const st = db.prepare("SELECT is_st_history_json FROM security WHERE code='920575'").get() as any;
    const parsed = JSON.parse(st.is_st_history_json);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].to).toBe(null);
    const normal = db.prepare("SELECT is_st_history_json FROM security WHERE code='601012'").get() as any;
    expect(normal.is_st_history_json).toBe(null);
  });

  it("已有观测记录不被覆盖 —— 否则每次跑都把起点刷成今天", () => {
    addSecurity("920575", "*ST康乐");
    db.prepare("UPDATE security SET is_st_history_json = ? WHERE code='920575'")
      .run(JSON.stringify([{ from: "2025-01-01", to: null }]));
    expect(seedStObservation(db)).toBe(0);
    const st = db.prepare("SELECT is_st_history_json FROM security WHERE code='920575'").get() as any;
    expect(JSON.parse(st.is_st_history_json)[0].from).toBe("2025-01-01");
  });
});
