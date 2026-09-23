import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseHoldingPlans } from "@/lib/data/sources/ths";
import { isReductionPlanTitle, parseNoticePage } from "@/lib/data/sources/eastmoney";

const here = path.dirname(fileURLToPath(import.meta.url));
const real = fs.readFileSync(path.join(here, "fixtures/ths-event-002237.html"), "utf8");

describe("parseHoldingPlans（同花顺 F10 事件页）", () => {
  it("真实页面：解析出两条计划，字段齐全", () => {
    const ps = parseHoldingPlans(real);
    expect(ps.length).toBe(2);
    expect(ps[0]).toEqual({
      actor: "公司其他股东烟台恒邦集团有限公司",
      direction: "减持",
      startDate: "2026-10-23", endDate: "2027-01-22",
      maxShares: 14300000, maxRatio: 0.01,
    });
  });

  it("**已过期的旧计划照样解析出来** —— 过滤归下游按日期做，源这层不替人判断", () => {
    const ps = parseHoldingPlans(real);
    expect(ps[1]).toMatchObject({ startDate: "2026-02-26", endDate: "2026-05-25" });
  });

  it("其它事件（分红送转）不会被误认成计划", () => {
    expect(parseHoldingPlans(real).every(p => p.direction === "减持")).toBe(true);
  });

  it("增持计划标成「增持」—— 它不是风险，混进减持会把利好当利空", () => {
    const html = `<strong class="hltip title fl">增减持计划：</strong><span>公司控股股东某某集团计划自2026-10-01起至2027-03-31，拟增持不超过5000万股，占总股本比例2.00%</span>`;
    expect(parseHoldingPlans(html)[0].direction).toBe("增持");
  });

  it("股数单位：万 / 亿 / 无单位都换算成股", () => {
    const mk = (s: string) =>
      `<strong class="hltip title fl">增减持计划：</strong><span>公司高管张三计划自2026-10-01起至2027-01-01，拟减持不超过${s}，占总股本比例0.05%</span>`;
    expect(parseHoldingPlans(mk("43.29万股"))[0].maxShares).toBe(432900);
    expect(parseHoldingPlans(mk("1.2亿股"))[0].maxShares).toBe(120000000);
    expect(parseHoldingPlans(mk("8000股"))[0].maxShares).toBe(8000);
  });

  it("比例是小数：1.00% → 0.01", () => {
    expect(parseHoldingPlans(real)[0].maxRatio).toBeCloseTo(0.01, 9);
  });

  it("句式对不上时跳过该条，而不是造一条字段为空的计划 —— 空字段的减持计划会被当成「没有上限」", () => {
    const html = `<strong class="hltip title fl">增减持计划：</strong><span>详见公司公告</span>`;
    expect(parseHoldingPlans(html)).toEqual([]);
  });

  it("页面没有计划段落时返回空数组", () => {
    expect(parseHoldingPlans("<html><body>无</body></html>")).toEqual([]);
  });
});

describe("isReductionPlanTitle（东财公告标题分类）", () => {
  it.each([
    "楚环科技:关于股东减持股份的预披露公告",
    "永安药业:关于部分董事、高级管理人员减持股份预披露公告",
    "华塑控股:关于持股5%以上股东减持公司股份预披露公告",
    "某某公司:关于控股股东减持股份计划的公告",
    // 变更可能是把比例调高 —— 多判一条只是多抓一次 F10，漏判是漏掉一个加重的风险
    "某某公司:关于变更股东减持股份计划的公告",
  ])("计划类 → true：%s", t => {
    expect(isReductionPlanTitle(t)).toBe(true);
  });

  it.each([
    "美年健康:关于5%以上股东减持股份计划实施完成的公告",
    "正邦科技:关于股东减持计划期限届满暨实施结果的公告",
    "某某公司:关于股东减持计划提前终止的公告",
    "某某公司:关于股东减持股份进展的公告",
    "某某公司:关于控股股东增持股份计划的公告",
  ])("非计划类 → false：%s", t => {
    expect(isReductionPlanTitle(t)).toBe(false);
  });
});

describe("parseNoticePage（东财公告列表）", () => {
  it("取出代码、公告日、标题", () => {
    const j = JSON.stringify({ data: { total_hits: 1, list: [{
      codes: [{ stock_code: "001336", short_name: "楚环科技" }],
      notice_date: "2026-09-23 00:00:00",
      title: "楚环科技:关于股东减持股份的预披露公告",
    }] } });
    expect(parseNoticePage(j).rows).toEqual([
      { code: "001336", noticeDate: "2026-09-23", title: "楚环科技:关于股东减持股份的预披露公告" },
    ]);
  });

  it("list 不是数组时抛错 —— 限流常表现成结构不对", () => {
    expect(() => parseNoticePage(JSON.stringify({ data: {} }))).toThrow(/notice/i);
  });
});
