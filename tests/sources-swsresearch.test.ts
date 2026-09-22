import { describe, it, expect } from "vitest";
import {
  parseComponents, parseIndexNames, level3Codes, SwBlocked,
  SW_LEVEL1, fetchComponents, SW_LEVEL3_EXPECTED,
} from "@/lib/data/sources/swsresearch";

/** 真实响应的缩样（申万银行 801780 前两条） */
const OK_JSON = JSON.stringify({
  code: "200",
  message: "ok",
  data: {
    count: 2,
    next: null,
    previous: null,
    results: [
      { stockcode: "002142", stockname: "宁波银行", newweight: "4.4631", beginningdate: "2021-12-13T08:00:00+08:00" },
      { stockcode: "601398", stockname: "工商银行", newweight: "8.1200", beginningdate: "2026-09-11T08:00:00+08:00" },
    ],
  },
});

/**
 * WAF 阻断页的真实形态：HTTP 200 + HTML。
 * 这是本模块最重要的一条防线 —— 只看状态码会把它当成功数据吞下去。
 */
const WAF_HTML =
  "<html><head><title>您的访问请求可能对网站造成安全威胁，请求已被阻断。</title></head><body>…</body></html>";

function stub(text: string, ok = true) {
  return {
    source: "sw",
    breakerFor: () => ({ isOpen: () => false, record() {}, reset() {} }),
    async get() {
      return ok
        ? { ok: true as const, text, status: 200, latencyMs: 5 }
        : { ok: false as const, error: "empty response body", latencyMs: 5 };
    },
  };
}

describe("parseComponents", () => {
  it("解析成成分数组，日期截成 YYYY-MM-DD", () => {
    const rows = parseComponents(OK_JSON, "801780");
    expect(rows.length).toBe(2);
    expect(rows[0]).toEqual({
      code: "002142", name: "宁波银行", weight: 4.4631, beginningDate: "2021-12-13",
    });
    expect(rows[1].beginningDate).toBe("2026-09-11");
  });

  it("权重缺失或非数字时留 null，不硬转成 0 —— 0 会被当成真实权重参与排序", () => {
    const j = JSON.stringify({
      code: "200", data: { count: 1, results: [{ stockcode: "1", stockname: "x", newweight: "", beginningdate: "2021-12-13T08:00:00+08:00" }] },
    });
    expect(parseComponents(j, "801780")[0].weight).toBeNull();
  });
});

describe("WAF 阻断必须抛错", () => {
  it("HTTP 200 的 HTML 阻断页抛 SwBlocked —— 绝不当成「这个行业没有成分股」", () => {
    expect(() => parseComponents(WAF_HTML, "801780")).toThrow(SwBlocked);
  });

  it("fetchComponents 遇到阻断页同样抛 SwBlocked，不返回空数组", async () => {
    await expect(fetchComponents(stub(WAF_HTML) as any, "801780")).rejects.toThrow(SwBlocked);
  });
});

describe("其它失败形态", () => {
  it("code 非 200 抛错", () => {
    expect(() => parseComponents(JSON.stringify({ code: "500", message: "boom" }), "801780"))
      .toThrow(/801780/);
  });

  it("count 大于实际取回条数时抛错 —— 分页没取全会静默少票，比报错危险得多", () => {
    const j = JSON.stringify({
      code: "200",
      data: { count: 42, results: [{ stockcode: "1", stockname: "x", newweight: "1", beginningdate: "2021-12-13T08:00:00+08:00" }] },
    });
    expect(() => parseComponents(j, "801780")).toThrow(/42/);
  });

  it("请求失败时抛错，不返回空数组", async () => {
    await expect(fetchComponents(stub("", false) as any, "801780")).rejects.toThrow(/sw/i);
  });
});

describe("SW_LEVEL1", () => {
  it("正好 31 个一级行业 —— 2021 版申万一级的口径", () => {
    expect(SW_LEVEL1.length).toBe(31);
  });

  it("不含风格指数与旧版残留（申万制造/申万300/Imp_*）", () => {
    const names = SW_LEVEL1.map(x => x.name);
    expect(names.some(n => n.startsWith("申万"))).toBe(false);
    expect(names.some(n => n.startsWith("Imp_"))).toBe(false);
    expect(names).toContain("电子");
    expect(names).toContain("美容护理");
  });

  it("代码全部是 801 开头的 6 位数字", () => {
    for (const { code } of SW_LEVEL1) expect(code).toMatch(/^801\d{3}$/);
  });
});

describe("level3Codes", () => {
  const names = JSON.stringify({
    code: "200",
    data: [
      { swindexcode: "850111", swindexname: "种子" },
      { swindexcode: "851111", swindexname: "某三级" },
      { swindexcode: "852111", swindexname: "某三级2" },
      { swindexcode: "857111", swindexname: "某三级3" },
      { swindexcode: "858111", swindexname: "某三级4" },
      { swindexcode: "859111", swindexname: "某三级5" },
      { swindexcode: "801780", swindexname: "银行" },
      { swindexcode: "000001", swindexname: "上证综合指数" },
      { swindexcode: "803111", swindexname: "非三级" },
    ],
  });

  it("只留 850/851/852/857/858/859 前缀", () => {
    const got = level3Codes(parseIndexNames(names));
    expect(got.map(x => x.code)).toEqual(["850111", "851111", "852111", "857111", "858111", "859111"]);
  });

  it("导出的期望条数是 346 —— 变了就是申万改了分类体系，必须人工确认而不是默默跟随", () => {
    expect(SW_LEVEL3_EXPECTED).toBe(346);
  });
});
