import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb } from "@/lib/db";
import { runMigrations } from "@/lib/db/migrate";
import { collectReductionPlans } from "@/lib/data/collectors/reduction-plan";

let dir: string, db: any;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "pt-rp-"));
  db = openDb(path.join(dir, "t.db"));
  runMigrations(db);
});
afterEach(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });

const plans = () => db.prepare("SELECT * FROM reduction_plan ORDER BY code, start_date").all();

const noticesJson = (items: Array<[string, string]>) => JSON.stringify({ data: {
  total_hits: items.length,
  list: items.map(([code, title]) => ({ codes: [{ stock_code: code }], notice_date: "2026-09-23 00:00:00", title })),
} });

const page = (sentences: string[]) =>
  "<html>" + "x".repeat(3000) +
  sentences.map(s => `<strong class="hltip title fl">增减持计划：</strong><span>${s}</span>`).join("") + "</html>";

function clients(opt: {
  notices: Array<[string, string]>; pages: Record<string, string | "FAIL">; noticeFail?: boolean;
}) {
  const thsCalls: string[] = [];
  const em = {
    source: "eastmoney", breakerFor: () => ({ isOpen: () => false, record() {}, reset() {} }),
    async get() {
      if (opt.noticeFail) return { ok: false as const, error: "timeout", latencyMs: 1 };
      return { ok: true as const, status: 200, latencyMs: 1, text: noticesJson(opt.notices) };
    },
  };
  const ths = {
    source: "ths", breakerFor: () => ({ isOpen: () => false, record() {}, reset() {} }),
    async get(url: string) {
      const code = /\/(\d{6})\//.exec(url)![1];
      thsCalls.push(code);
      const p = opt.pages[code];
      if (p === undefined || p === "FAIL") return { ok: false as const, error: "http 500", status: 500, latencyMs: 1 };
      return { ok: true as const, status: 200, latencyMs: 1, text: p };
    },
  };
  return { em: em as any, ths: ths as any, thsCalls };
}

const S = (actor: string, a: string, b: string, dir: "增" | "减" = "减") =>
  `${actor}计划自${a}起至${b}，拟${dir}持不超过1430万股，占总股本比例1.00%`;

describe("collectReductionPlans", () => {
  it("只对**计划类**公告的票去抓 F10 —— 实施完成/届满的不抓", async () => {
    const c = clients({
      notices: [
        ["001336", "楚环科技:关于股东减持股份的预披露公告"],
        ["002044", "美年健康:关于5%以上股东减持股份计划实施完成的公告"],
      ],
      pages: { "001336": page([S("公司股东甲", "2026-10-23", "2027-01-22")]) },
    });
    await collectReductionPlans(db, c, { from: "2026-09-23", to: "2026-09-23", date: "2026-09-23" });
    expect(c.thsCalls).toEqual(["001336"]);
    expect(plans().length).toBe(1);
  });

  it("同一只票多条公告只抓一次 F10", async () => {
    const c = clients({
      notices: [
        ["001336", "楚环科技:关于股东减持股份的预披露公告"],
        ["001336", "楚环科技:关于董事减持股份的预披露公告"],
      ],
      pages: { "001336": page([S("公司股东甲", "2026-10-23", "2027-01-22")]) },
    });
    await collectReductionPlans(db, c, { from: "2026-09-23", to: "2026-09-23", date: "2026-09-23" });
    expect(c.thsCalls).toEqual(["001336"]);
  });

  it("first_seen 保留**最早**那次 —— 第二次再看到同一条计划，不能把「知道它的日子」往后挪", async () => {
    const mk = () => clients({
      notices: [["001336", "楚环科技:关于股东减持股份的预披露公告"]],
      pages: { "001336": page([S("公司股东甲", "2026-10-23", "2027-01-22")]) },
    });
    await collectReductionPlans(db, mk(), { from: "2026-09-23", to: "2026-09-23", date: "2026-09-23" });
    await collectReductionPlans(db, mk(), { from: "2026-09-25", to: "2026-09-25", date: "2026-09-25" });
    expect(plans()[0].first_seen).toBe("2026-09-23");
  });

  it("增持计划也存，但方向标清楚", async () => {
    const c = clients({
      notices: [["600000", "浦发银行:关于控股股东减持股份计划的公告"]],
      pages: { "600000": page([S("控股股东乙", "2026-10-01", "2027-03-31", "增")]) },
    });
    await collectReductionPlans(db, c, { from: "2026-09-23", to: "2026-09-23", date: "2026-09-23" });
    expect(plans()[0].direction).toBe("增持");
  });

  it("公告列表拉失败：记可回补缺口，不抓任何 F10", async () => {
    const c = clients({ notices: [], pages: {}, noticeFail: true });
    const r = await collectReductionPlans(db, c, { from: "2026-09-23", to: "2026-09-23", date: "2026-09-23" });
    expect(c.thsCalls).toEqual([]);
    expect(r.failed.length).toBeGreaterThan(0);
    expect(db.prepare("SELECT recoverable FROM data_gap WHERE kind='reduction_plan:notices'").get().recoverable).toBe(1);
  });

  it("某只票的 F10 失败：逐只记缺口，其余照常", async () => {
    const c = clients({
      notices: [
        ["001336", "楚环科技:关于股东减持股份的预披露公告"],
        ["000509", "华塑控股:关于持股5%以上股东减持公司股份预披露公告"],
      ],
      pages: { "001336": "FAIL", "000509": page([S("股东丙", "2026-10-23", "2027-01-22")]) },
    });
    const r = await collectReductionPlans(db, c, { from: "2026-09-23", to: "2026-09-23", date: "2026-09-23" });
    expect(r.failed.map(f => f.code)).toEqual(["001336"]);
    expect(plans().map((p: any) => p.code)).toEqual(["000509"]);
  });
});

describe("目标过滤与熔断收手（实测 2026-09-23 踩到）", () => {
  /**
   * 东财"持股变动"栏目里混着可转债公告（110074 / 111009 …）。同花顺没有债券的 F10 页，
   * 返回空响应体 —— 3 次就打开熔断，后面 591 只（其中 556 只是真股票）全部 "circuit open"。
   */
  const seedSecurity = (codes: string[]) => {
    for (const c of codes) db.prepare("INSERT INTO security (code, name, board) VALUES (?, ?, '主板')").run(c, c);
  };

  it("只对证券表里的股票抓 F10 —— 可转债不是目标", async () => {
    seedSecurity(["001336"]);
    const c = clients({
      notices: [
        ["110074", "某转债:关于持有人减持可转债的预披露公告"],
        ["001336", "楚环科技:关于股东减持股份的预披露公告"],
      ],
      pages: { "001336": page([S("公司股东甲", "2026-10-23", "2027-01-22")]) },
    });
    await collectReductionPlans(db, c, { from: "2026-09-23", to: "2026-09-23", date: "2026-09-23" });
    expect(c.thsCalls).toEqual(["001336"]);
  });

  it("证券表为空时不过滤 —— 空表多半是还没灌清单，不该因此一只都不抓", async () => {
    const c = clients({
      notices: [["001336", "楚环科技:关于股东减持股份的预披露公告"]],
      pages: { "001336": page([S("公司股东甲", "2026-10-23", "2027-01-22")]) },
    });
    await collectReductionPlans(db, c, { from: "2026-09-23", to: "2026-09-23", date: "2026-09-23" });
    expect(c.thsCalls).toEqual(["001336"]);
  });

  it("熔断打开后**立刻收手**，记一条聚合缺口，不给后面每只各记一条", async () => {
    seedSecurity(["000001", "000002", "000003", "000004"]);
    let n = 0;
    const em = {
      source: "eastmoney", breakerFor: () => ({ isOpen: () => false, record() {}, reset() {} }),
      async get() {
        return { ok: true as const, status: 200, latencyMs: 1, text: noticesJson([
          ["000001", "甲:关于股东减持股份的预披露公告"], ["000002", "乙:关于股东减持股份的预披露公告"],
          ["000003", "丙:关于股东减持股份的预披露公告"], ["000004", "丁:关于股东减持股份的预披露公告"],
        ]) };
      },
    };
    const ths = {
      source: "ths", breakerFor: () => ({ isOpen: () => false, record() {}, reset() {} }),
      async get() {
        n++;
        return { ok: false as const, error: "circuit open for basic.10jqka.com.cn", latencyMs: 0 };
      },
    };
    const r = await collectReductionPlans(db, { em: em as any, ths: ths as any },
      { from: "2026-09-23", to: "2026-09-23", date: "2026-09-23" });

    expect(n).toBe(1);                                   // 第一只就遇到熔断，后面不再白打
    const perCode = db.prepare(
      "SELECT COUNT(*) n FROM data_gap WHERE kind LIKE 'reduction_plan:0%' AND resolved_at IS NULL").get().n;
    expect(perCode).toBe(0);
    const agg: any = db.prepare(
      "SELECT * FROM data_gap WHERE kind='reduction_plan:circuit' AND resolved_at IS NULL").get();
    expect(agg).toBeTruthy();
    expect(agg.reason).toMatch(/4/);                      // 点名有几只没抓到
    expect(r.failed.length).toBe(4);
  });
});
