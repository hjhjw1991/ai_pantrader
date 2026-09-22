import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb } from "@/lib/db";
import { runMigrations } from "@/lib/db/migrate";
import {
  collectSwIndustry, lastSwSnapshotDate, swSnapshotDue, SW_SNAPSHOT_MAX_AGE_DAYS,
} from "@/lib/data/collectors/sw-industry";

let dir: string, db: any;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "pt-sw-"));
  db = openDb(path.join(dir, "t.db"));
  runMigrations(db);
});
afterEach(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });

const WAF_HTML = "<html><title>您的访问请求可能对网站造成安全威胁，请求已被阻断。</title></html>";

function comp(rows: Array<[string, string]>) {
  return JSON.stringify({
    code: "200",
    data: {
      count: rows.length,
      results: rows.map(([c, n]) => ({
        stockcode: c, stockname: n, newweight: "1.0", beginningdate: "2021-12-13T08:00:00+08:00",
      })),
    },
  });
}

/** 三级行业名单：默认只给 1 个，够验证层级与流程；数量断言另有专门用例 */
function names(l3: string[]) {
  return JSON.stringify({
    code: "200",
    data: [
      { swindexcode: "801780", swindexname: "银行" },
      ...l3.map(c => ({ swindexcode: c, swindexname: `三级${c}` })),
    ],
  });
}

/** 按 URL 路由的 stub：index_name 与各行业成分各返回各的 */
function stub(payloads: Record<string, string>, l3: string[] = ["850111"]) {
  const calls: string[] = [];
  return {
    calls,
    client: {
      source: "sw",
      breakerFor: () => ({ isOpen: () => false, record() {}, reset() {} }),
      async get(url: string) {
        calls.push(url);
        if (url.includes("index_name")) {
          return { ok: true as const, text: names(l3), status: 200, latencyMs: 1 };
        }
        const m = /swindexcode=(\d+)/.exec(url);
        const code = m === null ? "" : m[1];
        const text = payloads[code];
        if (text === undefined) return { ok: true as const, text: comp([]), status: 200, latencyMs: 1 };
        return { ok: true as const, text, status: 200, latencyMs: 1 };
      },
    },
  };
}

const rowsOf = (d: any) =>
  d.prepare("SELECT * FROM sw_industry_snapshot ORDER BY level, code").all();

describe("collectSwIndustry", () => {
  it("一级与三级分别落快照行，level 字段区分开", async () => {
    const s = stub({ "801780": comp([["600036", "招商银行"]]), "850111": comp([["000998", "隆平高科"]]) });
    await collectSwIndustry(db, s.client as any, { snapshotDate: "2026-09-22" });

    const rows = rowsOf(db);
    const l1 = rows.filter((r: any) => r.level === 1);
    const l3 = rows.filter((r: any) => r.level === 3);
    expect(l1.some((r: any) => r.code === "600036" && r.index_name === "银行")).toBe(true);
    expect(l3.some((r: any) => r.code === "000998" && r.index_code === "850111")).toBe(true);
    expect(rows[0].snapshot_date).toBe("2026-09-22");
  });

  it("计入日期原样存下来 —— 它是后面差分推退出日期的锚", async () => {
    const s = stub({ "801780": comp([["600036", "招商银行"]]) });
    await collectSwIndustry(db, s.client as any, { snapshotDate: "2026-09-22" });
    const r: any = db.prepare("SELECT beginning_date FROM sw_industry_snapshot WHERE code='600036'").get();
    expect(r.beginning_date).toBe("2021-12-13");
  });

  it("某个行业被 WAF 拦：记 data_gap，且不给该行业写任何行，其余行业照常写", async () => {
    const s = stub({ "801780": WAF_HTML, "850111": comp([["000998", "隆平高科"]]) });
    const res = await collectSwIndustry(db, s.client as any, { snapshotDate: "2026-09-22" });

    expect(res.failed.map(f => f.indexCode)).toContain("801780");
    const rows = rowsOf(db);
    expect(rows.some((r: any) => r.index_code === "801780")).toBe(false);
    expect(rows.some((r: any) => r.index_code === "850111")).toBe(true);

    const gaps: any[] = db.prepare("SELECT * FROM data_gap WHERE kind LIKE 'sw_industry%'").all();
    expect(gaps.length).toBeGreaterThan(0);
  });

  it("三级行业数不等于 346 时记缺口告警 —— 分类体系变了必须有人看见，不能默默跟随", async () => {
    const s = stub({ "801780": comp([["600036", "招商银行"]]), "850111": comp([["000998", "隆平高科"]]) });
    await collectSwIndustry(db, s.client as any, { snapshotDate: "2026-09-22" });
    const gaps: any[] = db.prepare(
      "SELECT * FROM data_gap WHERE kind='sw_industry:level3_count'").all();
    expect(gaps.length).toBe(1);
    expect(gaps[0].reason).toMatch(/346/);
  });

  it("同一天重跑幂等：不重复行、不报错", async () => {
    const s = stub({ "801780": comp([["600036", "招商银行"]]), "850111": comp([["000998", "隆平高科"]]) });
    await collectSwIndustry(db, s.client as any, { snapshotDate: "2026-09-22" });
    const n1 = rowsOf(db).length;
    await collectSwIndustry(db, s.client as any, { snapshotDate: "2026-09-22" });
    expect(rowsOf(db).length).toBe(n1);
  });

  it("串行请求，不并发 —— 并发 ≥3 会被 WAF 拦", async () => {
    let inFlight = 0, maxInFlight = 0;
    const client = {
      source: "sw",
      breakerFor: () => ({ isOpen: () => false, record() {}, reset() {} }),
      async get(url: string) {
        inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise(r => setTimeout(r, 1));
        inFlight--;
        if (url.includes("index_name")) {
          return { ok: true as const, text: names(["850111"]), status: 200, latencyMs: 1 };
        }
        return { ok: true as const, text: comp([["600036", "招商银行"]]), status: 200, latencyMs: 1 };
      },
    };
    await collectSwIndustry(db, client as any, { snapshotDate: "2026-09-22" });
    expect(maxInFlight).toBe(1);
  });
});

describe("刷新节奏", () => {
  /** 一张**完整**快照：一级与三级都有。半张的情形另有专门用例 */
  const seed = (d: string) => {
    for (const level of [1, 3]) {
      db.prepare(
        `INSERT OR REPLACE INTO sw_industry_snapshot
           (snapshot_date, code, level, index_code, index_name, weight, beginning_date)
         VALUES (?, '600036', ?, '801780', '银行', 1.0, '2021-12-13')`
      ).run(d, level);
    }
  };

  it("空表时没有最近快照", () => {
    expect(lastSwSnapshotDate(db)).toBeNull();
  });

  it("取最新的那张快照日期", () => {
    seed("2026-09-01"); seed("2026-09-15"); seed("2026-09-08");
    expect(lastSwSnapshotDate(db)).toBe("2026-09-15");
  });

  it("空表一定要采 —— 一张都没有的时候差分无从谈起", () => {
    expect(swSnapshotDue(db, new Date("2026-09-22T22:00:00+08:00"))).toBe(true);
  });

  it("满 7 天才再采一次，不足 7 天不重复打源", () => {
    seed("2026-09-15");
    expect(swSnapshotDue(db, new Date("2026-09-21T22:00:00+08:00"))).toBe(false);
    expect(swSnapshotDue(db, new Date("2026-09-22T22:00:00+08:00"))).toBe(true);
  });

  it("快照日期是脏数据时当成该采 —— 宁可多采一次，也不要因为一个解析不了的日期永远不更新", () => {
    seed("not-a-date");
    expect(swSnapshotDue(db, new Date("2026-09-22T22:00:00+08:00"))).toBe(true);
  });

  it("周期是 7 天", () => {
    expect(SW_SNAPSHOT_MAX_AGE_DAYS).toBe(7);
  });
});

describe("半张快照不能堵死重试", () => {
  const seedLevel = (d: string, level: 1 | 3, code: string) =>
    db.prepare(
      `INSERT OR REPLACE INTO sw_industry_snapshot
         (snapshot_date, code, level, index_code, index_name, weight, beginning_date)
       VALUES (?, ?, ?, '801780', '银行', 1.0, '2021-12-13')`
    ).run(d, code, level);

  it("只有一级、三级空缺时仍然该采 —— 否则 7 天内不会重试，这一周的行业变更永久推不出来", () => {
    seedLevel("2026-09-22", 1, "600036");
    expect(swSnapshotDue(db, new Date("2026-09-22T23:00:00+08:00"))).toBe(true);
  });

  it("两层都有才算一张完整快照，7 天内不再打源", () => {
    seedLevel("2026-09-22", 1, "600036");
    seedLevel("2026-09-22", 3, "600036");
    expect(swSnapshotDue(db, new Date("2026-09-23T23:00:00+08:00"))).toBe(false);
  });

  it("完整快照满 7 天后照常该采", () => {
    seedLevel("2026-09-15", 1, "600036");
    seedLevel("2026-09-15", 3, "600036");
    expect(swSnapshotDue(db, new Date("2026-09-22T23:00:00+08:00"))).toBe(true);
  });
});

describe("采成功要销账", () => {
  const openGap = (kind: string) =>
    db.prepare(
      `INSERT INTO data_gap (date, source, kind, reason, recoverable, detected_at)
       VALUES ('2026-09-22', 'sw', ?, '上一次失败', 1, '2026-09-22 10:00:00.000')`
    ).run(kind);

  const unresolved = () =>
    db.prepare(
      "SELECT kind FROM data_gap WHERE kind LIKE 'sw_industry%' AND resolved_at IS NULL"
    ).all().map((r: any) => r.kind);

  it("这一轮采到的行业，它之前的缺口要销掉 —— 回测的 hasGap(date) 不带 kind，一条没销的缺口会让整个交易日对全市场直接跳过", async () => {
    openGap("sw_industry:801780");
    openGap("sw_industry:index_name");
    const s = stub({ "801780": comp([["600036", "招商银行"]]), "850111": comp([["000998", "隆平高科"]]) });
    await collectSwIndustry(db, s.client as any, { snapshotDate: "2026-09-22" });
    // level3_count 那条不在此列：stub 只给 1 个三级，数量校验本来就该报警且**不该**被销掉
    expect(unresolved()).not.toContain("sw_industry:801780");
    expect(unresolved()).not.toContain("sw_industry:index_name");
  });

  it("这一轮仍然失败的行业，缺口保持未解决 —— 销掉等于谎报已修复", async () => {
    const s = stub({ "801780": WAF_HTML, "850111": comp([["000998", "隆平高科"]]) });
    await collectSwIndustry(db, s.client as any, { snapshotDate: "2026-09-22" });
    expect(unresolved()).toContain("sw_industry:801780");
  });
});
