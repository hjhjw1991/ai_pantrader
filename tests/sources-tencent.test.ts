import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fetchGtimgBatch, chunk, GTIMG_BATCH_SIZE } from "@/lib/data/sources/tencent";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = fs.readFileSync(path.join(here, "fixtures/gtimg.txt"), "utf8");

function stubClient(text: string, ok = true) {
  return {
    source: "tencent",
    breaker: { isOpen: () => false, record() {}, reset() {} } as any,
    async get() {
      return ok
        ? { ok: true as const, text, status: 200, latencyMs: 5 }
        : { ok: false as const, error: "empty response body", latencyMs: 5 };
    },
  };
}

/** 造一条字段布局与真实报文一致的 gtimg 行 */
function gtimgLine(code: string, name: string, price: string): string {
  const f = Array(88).fill("1");
  f[1] = name; f[2] = code; f[3] = price; f[4] = "12.99"; f[5] = "13.00";
  f[32] = "1.69"; f[33] = "13.37"; f[34] = "12.98"; f[38] = "1.10"; f[43] = "3.00";
  return `v_${code.startsWith("6") ? "sh" : "sz"}${code}="${f.join("~")}";`;
}

describe("chunk", () => {
  it("按 size 切分且不丢元素", () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });

  it("空数组返回空", () => {
    expect(chunk([], 60)).toEqual([]);
  });
});

describe("fetchGtimgBatch", () => {
  it("解析多只票，字段类型正确", async () => {
    const qs = await fetchGtimgBatch(stubClient(fixture) as any, ["601012", "000001", "300750"]);
    expect(qs.length).toBe(3);
    const q = qs[0];
    expect(q.code).toBe("601012");
    expect(q.name.length).toBeGreaterThan(0);
    expect(Number.isFinite(q.price)).toBe(true);
    expect(Number.isFinite(q.pct)).toBe(true);
    expect(Number.isFinite(q.turnover)).toBe(true);
  });

  it("超过批量上限直接抛错", async () => {
    const codes = Array.from({ length: GTIMG_BATCH_SIZE + 1 }, (_, i) => String(600000 + i));
    await expect(fetchGtimgBatch(stubClient(fixture) as any, codes)).rejects.toThrow(/batch/i);
  });

  it("请求失败抛错而非返回空", async () => {
    await expect(
      fetchGtimgBatch(stubClient("", false) as any, ["601012"])
    ).rejects.toThrow(/gtimg/i);
  });

  it("跳过无数据的噪声行(v_pv_none_match)而不崩溃", async () => {
    const text = gtimgLine("601012", "隆基绿能", "13.21") + "\n" + 'v_pv_none_match="1";' + "\n";
    const qs = await fetchGtimgBatch(stubClient(text) as any, ["601012", "999999"]);
    expect(qs.length).toBe(1);
    expect(qs[0].code).toBe("601012");
  });
});
