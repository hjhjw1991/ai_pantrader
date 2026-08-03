import { describe, it, expect, vi, afterEach } from "vitest";
import { httpGet } from "@/lib/data/http";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function mockFetch(impl: any) {
  vi.stubGlobal("fetch", vi.fn(impl));
}

describe("httpGet", () => {
  it("成功返回 utf8 文本", async () => {
    mockFetch(async () => new Response("hello", { status: 200 }));
    const r = await httpGet("https://x.test/a");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.text).toBe("hello");
  });

  it("带上 User-Agent 与 Referer", async () => {
    let seen: any;
    mockFetch(async (_u: string, init: any) => { seen = init.headers; return new Response("{}"); });
    await httpGet("https://x.test/a", { referer: "https://finance.sina.com.cn" });
    expect(seen["User-Agent"]).toContain("Mozilla");
    expect(seen["Referer"]).toBe("https://finance.sina.com.cn");
  });

  it("GBK 解码", async () => {
    // "隆基绿能" 的 GBK 字节
    const gbk = Buffer.from([0xc2, 0xa1, 0xbb, 0xf9, 0xc2, 0xcc, 0xc4, 0xdc]);
    mockFetch(async () => new Response(gbk, { status: 200 }));
    const r = await httpGet("https://qt.gtimg.cn/q=x", { encoding: "gbk" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.text).toBe("隆基绿能");
  });

  it("空响应体判定为失败，不静默返回空", async () => {
    mockFetch(async () => new Response("", { status: 200 }));
    const r = await httpGet("https://x.test/a", { retries: 0 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/empty/i);
  });

  it("非 2xx 判定为失败", async () => {
    mockFetch(async () => new Response("nope", { status: 503 }));
    const r = await httpGet("https://x.test/a", { retries: 0 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(503);
  });

  it("失败后按 retries 重试，最终成功", async () => {
    let n = 0;
    mockFetch(async () => { n++; return n < 3 ? new Response("", { status: 200 }) : new Response("ok"); });
    const r = await httpGet("https://x.test/a", { retries: 2, retryDelayMs: 1 });
    expect(r.ok).toBe(true);
    expect(n).toBe(3);
  });

  it("超时返回失败而非挂起", async () => {
    mockFetch((_u: string, init: any) => new Promise((_res, rej) => {
      init.signal.addEventListener("abort", () => rej(new DOMException("aborted", "AbortError")));
    }));
    const r = await httpGet("https://x.test/a", { timeoutMs: 20, retries: 0 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/timeout|abort/i);
  });
});
