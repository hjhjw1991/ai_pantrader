import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fetchSinaKline, marketSymbol } from "@/lib/data/sources/sina";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = fs.readFileSync(path.join(here, "fixtures/sina-kline.json"), "utf8");

function stubClient(text: string, ok = true) {
  return {
    source: "sina",
    breaker: { isOpen: () => false, record() {}, reset() {} } as any,
    async get() {
      return ok
        ? { ok: true as const, text, status: 200, latencyMs: 5 }
        : { ok: false as const, error: "empty response body", latencyMs: 5 };
    },
  };
}

describe("marketSymbol", () => {
  it("6 开头映射 sh", () => {
    expect(marketSymbol("601012")).toBe("sh601012");
    expect(marketSymbol("688981")).toBe("sh688981");
  });

  it("深市映射 sz", () => {
    expect(marketSymbol("000001")).toBe("sz000001");
    expect(marketSymbol("300750")).toBe("sz300750");
  });

  it("北交所映射 bj —— sz/sh 前缀取不到北交所行情", () => {
    expect(marketSymbol("832317")).toBe("bj832317");
    expect(marketSymbol("430418")).toBe("bj430418");
    expect(marketSymbol("920001")).toBe("bj920001");
    expect(marketSymbol("810011")).toBe("bj810011");
  });
});

describe("fetchSinaKline", () => {
  it("解析成 Bar 数组，数值全部转 number", async () => {
    const bars = await fetchSinaKline(stubClient(fixture) as any, "601012", 5, 5);
    expect(bars.length).toBeGreaterThan(0);
    const b = bars[0];
    expect(typeof b.ts).toBe("string");
    expect(typeof b.o).toBe("number");
    expect(Number.isFinite(b.c)).toBe(true);
    expect(b.h).toBeGreaterThanOrEqual(b.l);
  });

  it("请求失败时抛错，不返回空数组", async () => {
    await expect(
      fetchSinaKline(stubClient("", false) as any, "601012", 5, 5)
    ).rejects.toThrow(/sina/i);
  });

  it("返回非数组 JSON 时抛错", async () => {
    await expect(
      fetchSinaKline(stubClient("null") as any, "601012", 5, 5)
    ).rejects.toThrow(/unexpected/i);
  });
});
