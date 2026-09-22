import { describe, it, expect } from "vitest";
import {
  parseAdjustFactors, factorAt, fetchAdjustFactors, SourceNoAdjust, AdjustUnsupported,
} from "@/lib/data/sources/sina-adjust";

/** 真实响应的缩样：var 赋值 + 尾部 JS 注释块（新浪会在末尾塞一段混淆注释） */
const OK = `var sh600000hfq={"total":4,"data":[` +
  `{"d":"2026-07-16", "f":"17.3916341988312000"},` +
  `{"d":"2002-08-22", "f":"1.5263436173000000"},` +
  `{"d":"1999-11-10", "f":"1.0000000000000000"},` +
  `{"d":"1900-01-01", "f":"1.0000000000000000"}]}\n` +
  `/* obfuscated-tail-Xy9Z */`;

function stub(text: string, ok = true, status?: number) {
  return {
    source: "sina",
    breakerFor: () => ({ isOpen: () => false, record() {}, reset() {} }),
    async get() {
      return ok
        ? { ok: true as const, text, status: 200, latencyMs: 3 }
        : { ok: false as const, error: `http ${status ?? 0}`, status, latencyMs: 3 };
    },
  };
}

describe("parseAdjustFactors", () => {
  it("解析出按日期升序的因子表", () => {
    const rows = parseAdjustFactors(OK, "600000");
    expect(rows.map(r => r.date)).toEqual(["1900-01-01", "1999-11-10", "2002-08-22", "2026-07-16"]);
    expect(rows[3].factor).toBeCloseTo(17.3916341988312, 9);
  });

  it("尾部的 JS 注释块不能让解析挂掉 —— 新浪确实会塞这段", () => {
    expect(() => parseAdjustFactors(OK, "600000")).not.toThrow();
  });

  it("空数据抛 SourceNoAdjust —— 「这只票没有除权记录」不是采集失败", () => {
    const empty = `var sz000001hfq={"total":0,"data":[]}`;
    expect(() => parseAdjustFactors(empty, "000001")).toThrow(SourceNoAdjust);
  });

  it("不是合法 payload 时抛普通错误，不能当成没有除权", () => {
    const e = (() => { try { parseAdjustFactors("<html>blocked</html>", "600000"); } catch (x) { return x; } })();
    expect(e).not.toBeInstanceOf(SourceNoAdjust);
    expect((e as Error).message).toMatch(/600000/);
  });

  it("因子为 0 或负数直接抛错 —— 拿它去乘会把整段历史价格清零或翻负", () => {
    const bad = `var sh600000hfq={"total":1,"data":[{"d":"2020-01-01","f":"0"}]}`;
    expect(() => parseAdjustFactors(bad, "600000")).toThrow(/因子/);
  });
});

describe("factorAt", () => {
  const rows = parseAdjustFactors(OK, "600000");

  it("取「不晚于该日」的最后一条 —— 因子从除权日当天起生效", () => {
    expect(factorAt(rows, "2026-07-16")).toBeCloseTo(17.3916341988312, 9);
    expect(factorAt(rows, "2026-07-15")).toBeCloseTo(1.5263436173, 9);
    expect(factorAt(rows, "2002-08-22")).toBeCloseTo(1.5263436173, 9);
    expect(factorAt(rows, "2002-08-21")).toBe(1);
  });

  it("上市前的日期落到 1900-01-01 那条哨兵上，值为 1", () => {
    expect(factorAt(rows, "1990-01-01")).toBe(1);
  });

  it("空表返回 1 —— 没有除权记录等于不需要复权，不是错误", () => {
    expect(factorAt([], "2026-07-16")).toBe(1);
  });
});

describe("fetchAdjustFactors", () => {
  it("请求失败抛错，不返回空表 —— 空表会被当成「无需复权」写进库", async () => {
    await expect(fetchAdjustFactors(stub("", false) as any, "600000")).rejects.toThrow(/sina/i);
  });

  it("成功时返回升序因子表", async () => {
    const rows = await fetchAdjustFactors(stub(OK) as any, "600000");
    expect(rows.length).toBe(4);
    expect(rows[0].date < rows[3].date).toBe(true);
  });
});

describe("源不覆盖这只票（北交所）", () => {
  it("HTTP 404 抛 AdjustUnsupported —— 新浪不为北交所提供 hfq.js，这是源的能力缺口不是采集事故", async () => {
    await expect(fetchAdjustFactors(stub("", false, 404) as any, "920001"))
      .rejects.toThrow(AdjustUnsupported);
  });

  it("AdjustUnsupported 不是 SourceNoAdjust —— 前者是「查不到」，后者是「确实没分红」，不能混为一谈", async () => {
    const e = await fetchAdjustFactors(stub("", false, 404) as any, "920001").catch(x => x);
    expect(e).not.toBeInstanceOf(SourceNoAdjust);
  });

  it("其它 HTTP 错误仍然是普通失败 —— 500 是源出问题，重试有意义", async () => {
    const e = await fetchAdjustFactors(stub("", false, 500) as any, "600000").catch(x => x);
    expect(e).not.toBeInstanceOf(AdjustUnsupported);
    expect((e as Error).message).toMatch(/600000/);
  });
});
