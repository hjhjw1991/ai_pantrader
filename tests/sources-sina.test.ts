import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fetchSinaKline, marketSymbol, SourceNoData } from "@/lib/data/sources/sina";

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
    // 注意别用 "null" 当样本：null 有专门语义（该 symbol 无序列），见 SourceNoData
    await expect(
      fetchSinaKline(stubClient('{"error":"x"}') as any, "601012", 5, 5)
    ).rejects.toThrow(/unexpected/i);
  });
});

describe("SourceNoData", () => {
  it("字面量 null 抛 SourceNoData —— 该 symbol 没有序列，不是采集失败", async () => {
    // 实测 2026-08-03 有 14 只（新股/北交所定向转让）新浪返回 null，
    // 当成缺口会让 data_gap 永远挂着回补不掉的记录
    await expect(
      fetchSinaKline(stubClient("null") as any, "001232", 240, 10)
    ).rejects.toThrow(SourceNoData);
  });

  it("空响应体仍然是普通失败 —— 那是限频，不能当成没数据", async () => {
    const e = await fetchSinaKline(stubClient("", false) as any, "601012", 240, 10)
      .catch(err => err);
    expect(e).not.toBeInstanceOf(SourceNoData);
  });

  it("其它非数组 payload 仍然是普通失败", async () => {
    const e = await fetchSinaKline(stubClient('{"x":1}') as any, "601012", 240, 10)
      .catch(err => err);
    expect(e).not.toBeInstanceOf(SourceNoData);
    expect(e.message).toMatch(/unexpected/i);
  });
});
