import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fetchZtPool, fetchAllSecurities, fetchLhb, boardOf, EM_PUSH2_HOSTS }
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
  it("解析龙虎榜并带 D1/D5/D10 后续涨跌", async () => {
    const rows = await fetchLhb(stubClient(read("em-lhb.json")) as any, "2025-07-15");
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0].date).toBe("2025-07-15");
    expect(rows[0].code).toMatch(/^\d{6}$/);
    expect("d1Chg" in rows[0]).toBe(true);
  });

  it("null 的后续涨跌保持 null，不转成 0", async () => {
    const rows = await fetchLhb(stubClient(read("em-lhb.json")) as any, "2025-07-15");
    const withNull = rows.find(r => r.d10Chg === null);
    expect(withNull).toBeDefined();
  });
});
