import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fetchZtPool, fetchAllSecurities, fetchLhb, fetchLhbSeats, boardOf, EM_PUSH2_HOSTS, EM_MARKET_FILTER }
  from "@/lib/data/sources/eastmoney";

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (f: string) => fs.readFileSync(path.join(here, "fixtures", f), "utf8");

function stubClient(text: string, ok = true) {
  return {
    source: "eastmoney",
    breaker: { isOpen: () => false, record() {}, reset() {} } as any,
    async get() {
      return ok
        ? { ok: true as const, text, status: 200, latencyMs: 5 }
        : { ok: false as const, error: "empty response body", latencyMs: 5 };
    },
  };
}

/** 记录被请求过的 URL，并按 host 决定成败——用于验证多主机轮换 */
function hostAwareClient(okHost: string, text: string) {
  const tried: string[] = [];
  return {
    tried,
    client: {
      source: "eastmoney",
      breaker: { isOpen: () => false, record() {}, reset() {} } as any,
      async get(url: string) {
        const host = new URL(url).hostname;
        tried.push(host);
        return host.startsWith(okHost)
          ? { ok: true as const, text, status: 200, latencyMs: 5 }
          : { ok: false as const, error: "empty response body", latencyMs: 5 };
      },
    },
  };
}

describe("boardOf", () => {
  it("按代码前缀判板", () => {
    expect(boardOf("601012")).toBe("主板");
    expect(boardOf("000001")).toBe("主板");
    expect(boardOf("300750")).toBe("创业板");
    expect(boardOf("301082")).toBe("创业板");
    expect(boardOf("688981")).toBe("科创板");
    expect(boardOf("830799")).toBe("北交所");
    expect(boardOf("920001")).toBe("北交所");
    expect(boardOf("430418")).toBe("北交所");
  });
});

describe("fetchZtPool", () => {
  it("解析涨停池并保留连板数、封单额、炸板次数", async () => {
    const rows = await fetchZtPool(stubClient(read("em-ztpool.json")) as any, "20260731");
    expect(rows.length).toBeGreaterThan(0);
    const r = rows[0];
    expect(typeof r.code).toBe("string");
    expect(Number.isFinite(r.lbc)).toBe(true);
    expect(Number.isFinite(r.sealAmt)).toBe(true);
    expect(Number.isFinite(r.openTimes)).toBe(true);
  });

  it("把 fbt/lbt 数字时间转成 HH:MM:SS", async () => {
    const payload = JSON.stringify({
      data: { pool: [{ c: "003032", n: "传智教育", lbc: 5, fund: 1, zbc: 1,
                       fbt: 92500, lbt: 93203, hybk: "教育", hs: 14.5 }] },
    });
    const rows = await fetchZtPool(stubClient(payload) as any, "20260731");
    expect(rows[0].firstSealTs).toBe("09:25:00");
    expect(rows[0].lastSealTs).toBe("09:32:03");
  });

  it("失败时抛错", async () => {
    await expect(fetchZtPool(stubClient("", false) as any, "20260731"))
      .rejects.toThrow(/ztpool/i);
  });
});

describe("fetchAllSecurities", () => {
  it("解析证券清单并附板块", async () => {
    const { client } = hostAwareClient(EM_PUSH2_HOSTS[0], read("em-clist.json"));
    const rows = await fetchAllSecurities(client as any, { rounds: 1 });
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0].code).toMatch(/^\d{6}$/);
    expect(["主板", "创业板", "科创板", "北交所"]).toContain(rows[0].board);
  });

  it("首个主机失败时自动轮换到下一个", async () => {
    const okHost = EM_PUSH2_HOSTS[2];
    const { tried, client } = hostAwareClient(okHost, read("em-clist.json"));
    const rows = await fetchAllSecurities(client as any, { rounds: 1 });
    expect(rows.length).toBeGreaterThan(0);
    expect(tried.length).toBeGreaterThanOrEqual(3);
    expect(tried[0]).toContain(EM_PUSH2_HOSTS[0]);
  });

  it("所有主机、所有轮次都失败时才抛错", async () => {
    const { client } = hostAwareClient("nonexistent-host", "");
    await expect(fetchAllSecurities(client as any, { rounds: 2, backoffMs: 1 }))
      .rejects.toThrow(/all .* hosts after 2 rounds/i);
  });

  /** 满页（100 条）payload，使分页逻辑继续翻下一页 */
  const fullPage = (total = 5545) => JSON.stringify({
    data: {
      total,
      diff: Array.from({ length: 100 }, (_, i) => ({
        f12: String(600000 + i).padStart(6, "0"), f14: `票${i}`,
      })),
    },
  });

  it("onPage 逐页交出本页数据，中途失败也保住已拉的页", async () => {
    const seen: Array<{ page: number; n: number }> = [];
    let calls = 0;
    const client = {
      source: "eastmoney",
      breaker: { isOpen: () => false, record() {}, reset() {} } as any,
      async get() {
        calls++;
        // 第一页成功，之后全失败
        return calls === 1
          ? { ok: true as const, text: fullPage(), status: 200, latencyMs: 1 }
          : { ok: false as const, error: "empty response body", latencyMs: 1 };
      },
    };
    await expect(fetchAllSecurities(client as any, {
      rounds: 1,
      onPage: (page, rows) => seen.push({ page, n: rows.length }),
    })).rejects.toThrow();

    // 关键：第一页的数据已经通过 onPage 交出去了
    expect(seen.length).toBe(1);
    expect(seen[0].page).toBe(1);
    expect(seen[0].n).toBe(100);
  });

  it("按代码升序分页，不按涨幅——否则盘中排序漂移会漏票", async () => {
    let url = "";
    const client = {
      source: "eastmoney",
      breaker: { isOpen: () => false, record() {}, reset() {} } as any,
      async get(u: string) {
        url = u;
        return { ok: true as const, text: read("em-clist.json"), status: 200, latencyMs: 1 };
      },
    };
    await fetchAllSecurities(client as any, { rounds: 1 });
    expect(url).toContain("fid=f12");
    expect(url).toContain("po=0");
    expect(url).not.toContain("fid=f3");
  });

  it("市场过滤器包含北交所，否则北交所票会全部缺失", async () => {
    let url = "";
    const client = {
      source: "eastmoney",
      breaker: { isOpen: () => false, record() {}, reset() {} } as any,
      async get(u: string) {
        url = u;
        return { ok: true as const, text: read("em-clist.json"), status: 200, latencyMs: 1 };
      },
    };
    await fetchAllSecurities(client as any, { rounds: 1 });
    expect(EM_MARKET_FILTER).toContain("m:0+t:81+s:2048");
    expect(decodeURIComponent(url)).toContain("m:0+t:81+s:2048");
  });

  it("startPage 支持断点续拉", async () => {
    const pages: number[] = [];
    const client = {
      source: "eastmoney",
      breaker: { isOpen: () => false, record() {}, reset() {} } as any,
      async get(url: string) {
        pages.push(Number(new URL(url).searchParams.get("pn")));
        return { ok: true as const, text: read("em-clist.json"), status: 200, latencyMs: 1 };
      },
    };
    await fetchAllSecurities(client as any, { startPage: 28, rounds: 1 });
    expect(pages[0]).toBe(28);
  });

  it("全主机失败后会退避重来，不是一轮就放弃", async () => {
    const tried: string[] = [];
    const client = {
      source: "eastmoney",
      breaker: { isOpen: () => false, record() {}, reset() {} } as any,
      async get(url: string) {
        tried.push(new URL(url).hostname);
        // 第一轮（前 10 次）全失败，第二轮起放行
        const ok = tried.length > EM_PUSH2_HOSTS.length;
        return ok
          ? { ok: true as const, text: read("em-clist.json"), status: 200, latencyMs: 1 }
          : { ok: false as const, error: "empty response body", latencyMs: 1 };
      },
    };
    const rows = await fetchAllSecurities(client as any, { rounds: 3, backoffMs: 1 });
    expect(rows.length).toBeGreaterThan(0);
    expect(tried.length).toBeGreaterThan(EM_PUSH2_HOSTS.length);
  });
});

describe("fetchLhb", () => {
  const load = () => fetchLhb(stubClient(read("em-lhb.json")) as any, "2026-08-03");

  it("解析龙虎榜并带 D1..D30 后续涨跌", async () => {
    const rows = await load();
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0].date).toBe("2026-08-03");
    expect(rows[0].code).toMatch(/^\d{6}$/);
    for (const k of ["d1Chg", "d2Chg", "d5Chg", "d10Chg", "d20Chg", "d30Chg"]) {
      expect(k in rows[0]).toBe(true);
    }
  });

  it("null 的后续涨跌保持 null，不转成 0", async () => {
    const rows = await load();
    expect(rows.find(r => r.d10Chg === null)).toBeDefined();
  });

  it("同一只票同一天的多条上榜原因全部保留 —— 折叠就是丢数据", async () => {
    const rows = await load();
    const dup = rows.filter(r => r.code === "002131");
    expect(dup.length).toBeGreaterThan(1);
    // 每条的 changeType 必须不同，否则 (date, code, change_type) 这个主键选择就是错的
    expect(new Set(dup.map(r => r.changeType)).size).toBe(dup.length);
  });

  it("explanation 是上榜原因，explainStat 才是机构/成功率统计", async () => {
    const rows = await load();
    const r = rows.find(x => x.code === "002131")!;
    // 早期版本把 EXPLAIN 当成了上榜原因，资金因子按它聚类会得到无意义的簇
    expect(r.explanation).toMatch(/证券|偏离|换手|振幅/);
    expect(r.explainStat).toMatch(/成功率|机构|营业部/);
    expect(r.explanation).not.toBe(r.explainStat);
  });

  it("带出席位/换手/成交占比等游资识别要用的字段", async () => {
    const rows = await load();
    const r = rows[0];
    expect(typeof r.turnoverRate).toBe("number");
    expect(typeof r.dealAmountRatio).toBe("number");
    expect(typeof r.accumAmount).toBe("number");
  });
});

describe("fetchLhbSeats", () => {
  it("解析买方营业部明细", async () => {
    const rows = await fetchLhbSeats(
      stubClient(read("em-lhb-seat-buy.json")) as any, "2026-08-03", "buy");
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0].side).toBe("buy");
    expect(rows[0].deptName.length).toBeGreaterThan(0);
    expect(typeof rows[0].netAmt).toBe("number");
  });

  it("卖方榜标成 sell", async () => {
    const rows = await fetchLhbSeats(
      stubClient(read("em-lhb-seat-sell.json")) as any, "2026-08-03", "sell");
    expect(rows.every(r => r.side === "sell")).toBe(true);
  });

  it("机构专用席位共用 dept_code=0 —— 业务键做主键必然丢行", async () => {
    const rows = await fetchLhbSeats(
      stubClient(read("em-lhb-seat-buy.json")) as any, "2026-08-03", "buy");
    const key = new Set(rows.map(r => `${r.code}|${r.changeType}|${r.deptCode}`));
    expect(key.size).toBeLessThan(rows.length);
  });
});
