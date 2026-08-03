import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createClient, resetClients } from "@/lib/data/client";
import { BreakerPool } from "@/lib/data/health";

beforeEach(() => { resetClients(); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); resetClients(); });

describe("BreakerPool", () => {
  it("不同 key 的熔断互不影响", () => {
    const p = new BreakerPool(3, 60_000);
    for (let i = 0; i < 3; i++) p.for("a.host").record(false);
    expect(p.for("a.host").isOpen()).toBe(true);
    expect(p.for("b.host").isOpen()).toBe(false);
  });

  it("allOpen 只有在全部 key 都熔断时为 true", () => {
    const p = new BreakerPool(3, 60_000);
    for (let i = 0; i < 3; i++) { p.for("a").record(false); p.for("b").record(false); }
    expect(p.allOpen()).toBe(true);
    p.for("c").record(true);
    expect(p.allOpen()).toBe(false);
  });

  it("空池不算全熔断", () => {
    expect(new BreakerPool().allOpen()).toBe(false);
  });
});

describe("SourceClient 熔断粒度", () => {
  it("一个主机熔断后，同源其他主机仍会真正发起请求", async () => {
    const tried: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      const host = new URL(url).hostname;
      tried.push(host);
      // bad.host 永远失败，good.host 正常
      return host === "good.host"
        ? new Response("ok", { status: 200 })
        : new Response("", { status: 200 });
    }));

    const c = createClient("t", { minIntervalMs: 0 });

    // 把 bad.host 打到熔断（3 次失败，每次内部还会重试，故 retries: 0）
    for (let i = 0; i < 3; i++) await c.get("https://bad.host/x", { retries: 0 });
    expect(c.breakerFor("bad.host").isOpen()).toBe(true);

    // 熔断后 bad.host 不再真发请求
    const before = tried.length;
    const blocked = await c.get("https://bad.host/x", { retries: 0 });
    expect(blocked.ok).toBe(false);
    expect(tried.length).toBe(before);

    // 关键断言：good.host 不受牵连，真的发出去了
    const r = await c.get("https://good.host/x", { retries: 0 });
    expect(r.ok).toBe(true);
    expect(tried).toContain("good.host");
  });
});
