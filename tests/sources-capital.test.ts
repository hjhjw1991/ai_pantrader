import { describe, it, expect } from "vitest";
import {
  parseDcEnvelope, parseMarginMarket, parseMarginStock, parseMutualDeal,
  parseMutualTop10, parseHolderChanges,
} from "@/lib/data/sources/eastmoney";

describe("parseDcEnvelope", () => {
  it("9201（返回数据为空）是合法的空", () => {
    expect(parseDcEnvelope(JSON.stringify({ success: false, code: 9201, message: "返回数据为空" }), "x"))
      .toEqual({ data: [], pages: 0 });
  });
  it("其它失败码一律抛 —— 报表名写错不是\"没有数据\"", () => {
    expect(() => parseDcEnvelope(JSON.stringify({ success: false, code: 9501, message: "报表不存在" }), "x"))
      .toThrow(/9501/);
  });
  it("非 JSON（风控页、HTML）抛", () => {
    expect(() => parseDcEnvelope("<html>", "x")).toThrow(/unexpected payload/);
  });
  it("result.data 不是数组时抛", () => {
    expect(() => parseDcEnvelope(JSON.stringify({ success: true, result: null }), "x")).toThrow();
  });
});

describe("两融解析", () => {
  it("全市场：RZYEZB 百分数 → 小数，金额元不变", () => {
    const [r] = parseMarginMarket([{ DIM_DATE: "2026-09-22 00:00:00", RZYE: 2626356590753, RQYE: 1, RZRQYE: 2,
      RZMRE: 3, RZCHE: 4, RZJME: 2924943748, RZYEZB: 2.614162, LTSZ: 1e14 }]);
    expect(r.date).toBe("2026-09-22");
    expect(r.rzye).toBe(2626356590753);
    expect(r.rzyezb).toBeCloseTo(0.02614162, 12);
  });
  it("个股：代码保留前导 0，缺失值保持 null", () => {
    const [r] = parseMarginStock([{ DATE: "2026-09-22 00:00:00", SCODE: "000001", RZYE: 4589562319,
      RZMRE: null, RZCHE: "-", RZJME: -13223540, RQYE: 0, RQYL: 0, RZRQYE: 0, RZYEZB: 2.01969318 }]);
    expect(r.code).toBe("000001");
    expect(r.rzmre).toBeNull();
    expect(r.rzche).toBeNull();
    expect(r.rzyezb).toBeCloseTo(0.0201969318, 12);
  });
  it("代码不是 6 位数字的行丢弃", () => {
    expect(parseMarginStock([{ DATE: "2026-09-22", SCODE: "" }])).toEqual([]);
  });
});

describe("互联互通解析", () => {
  it("DEAL_AMT 百万元 → 元；北向净买额 null 保持 null（停止披露，不是 0）", () => {
    const rs = parseMutualDeal([
      { MUTUAL_TYPE: "005", TRADE_DATE: "2026-09-22 00:00:00", DEAL_AMT: 291149.88, NET_DEAL_AMT: null },
      { MUTUAL_TYPE: "006", TRADE_DATE: "2026-09-22 00:00:00", DEAL_AMT: 110811.78, NET_DEAL_AMT: 12690.64 },
    ]);
    expect(rs[0].dealAmt).toBeCloseTo(291149.88e6, 0);
    expect(rs[0].netAmt).toBeNull();
    expect(rs[1].netAmt).toBeCloseTo(12690.64e6, 0);
  });
  it("十大成交：成交额已是元，MUTUAL_RATIO 百分数 → 小数", () => {
    const [r] = parseMutualTop10([{ MUTUAL_TYPE: "001", TRADE_DATE: "2026-09-22 00:00:00", SECURITY_CODE: "688256",
      RANK: 8, DEAL_AMT: 1472069655, MUTUAL_RATIO: 15.16 }]);
    expect(r).toMatchObject({ code: "688256", rank: 8, dealAmt: 1472069655 });
    expect(r.mutualRatio).toBeCloseTo(0.1516, 12);
  });
});

describe("增减持解析", () => {
  const base = { SECURITY_CODE: "300592", HOLDER_NAME: "罗晔", START_DATE: "2026-09-08 00:00:00",
    END_DATE: "2026-09-18 00:00:00", NOTICE_DATE: "2026-09-21 00:00:00", CHANGE_NUM: 160,
    CHANGE_FREE_RATIO: 0.47, HOLD_RATIO: 2.45, MARKET: "二级市场" };
  it("减持：万股 → 股、百分数 → 小数，且带负号", () => {
    const [r] = parseHolderChanges([{ ...base, DIRECTION: "减持" }]);
    expect(r.changeShares).toBe(-1_600_000);
    expect(r.changeFreeRatio).toBeCloseTo(-0.0047, 12);
    expect(r.afterHoldRatio).toBeCloseTo(0.0245, 12);
    expect(r.noticeDate).toBe("2026-09-21");
  });
  it("增持为正；符号只看 DIRECTION，不信数值字段自带的正负", () => {
    const [r] = parseHolderChanges([{ ...base, DIRECTION: "增持", CHANGE_NUM: -160, CHANGE_FREE_RATIO: -0.47 }]);
    expect(r.changeShares).toBe(1_600_000);
    expect(r.changeFreeRatio).toBeCloseTo(0.0047, 12);
  });
  it("方向不认识的行丢弃（由采集器按条数差报出来）", () => {
    expect(parseHolderChanges([{ ...base, DIRECTION: "不变" }])).toEqual([]);
  });
  it("比例缺失保持 null", () => {
    const [r] = parseHolderChanges([{ ...base, DIRECTION: "减持", CHANGE_FREE_RATIO: null }]);
    expect(r.changeFreeRatio).toBeNull();
  });
});

/**
 * 分页排序键必须覆盖主键。
 *
 * datacenter 按 sortColumns 翻页；排序键有并列时，并列行在页与页之间的顺序不稳定，
 * 结果是**重一批、漏一批而条数不变**。实测增减持 2021 年：13974 行里重 22、漏 22。
 * 这类错没有任何报错，所以用 URL 断言把它钉死。
 */
describe("分页排序键覆盖主键", () => {
  const capture = () => {
    const urls: string[] = [];
    return {
      urls,
      client: {
        source: "eastmoney",
        async get(u: string) {
          urls.push(decodeURIComponent(u));
          return { ok: true as const, status: 200, latencyMs: 1,
            text: JSON.stringify({ success: true, result: { pages: 1, data: [] } }) };
        },
      } as any,
    };
  };
  it("增减持：(公告日, 代码, 股东, 起, 止, 方向, 渠道)", async () => {
    const { fetchHolderChanges } = await import("@/lib/data/sources/eastmoney");
    const c = capture();
    await fetchHolderChanges(c.client, "2026-01-01", "2026-01-31");
    expect(c.urls[0]).toContain("sortColumns=NOTICE_DATE,SECURITY_CODE,HOLDER_NAME,START_DATE,END_DATE,DIRECTION,MARKET");
  });
  it("解禁：(解禁日, 代码, 类型)", async () => {
    const { fetchLiftSchedule } = await import("@/lib/data/sources/eastmoney");
    const c = capture();
    await fetchLiftSchedule(c.client, "2026-01-01", "2026-01-31");
    expect(c.urls[0]).toContain("sortColumns=FREE_DATE,SECURITY_CODE,FREE_SHARES_TYPE");
  });
});
