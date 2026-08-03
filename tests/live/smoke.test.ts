import { describe, it, expect } from "vitest";
import { createClient, resetClients } from "@/lib/data/client";
import { fetchSinaKline, fetchSinaKlineBySymbol } from "@/lib/data/sources/sina";
import { fetchGtimgBatch } from "@/lib/data/sources/tencent";
import { fetchZtPool } from "@/lib/data/sources/eastmoney";

const live = process.env.PANTRADER_LIVE === "1";
const d = live ? describe : describe.skip;

const shanghaiToday = () => new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
}).format(new Date());

d("live smoke（打真实接口）", () => {
  it("新浪分钟线可取", async () => {
    resetClients();
    const c = createClient("sina-live-min", { minIntervalMs: 400 });
    const bars = await fetchSinaKline(c, "601012", 5, 10);
    expect(bars.length).toBeGreaterThan(0);
    expect(Number.isFinite(bars[0].c)).toBe(true);
  }, 40_000);

  it("新浪上证指数日线可取（交易日历数据源）", async () => {
    resetClients();
    const c = createClient("sina-live-idx", { minIntervalMs: 400 });
    const bars = await fetchSinaKlineBySymbol(c, "sh000001", 240, 10);
    expect(bars.length).toBeGreaterThan(0);
    // 指数点位在千级，若误取成 sz000001(平安银行) 会是十几块
    expect(bars[bars.length - 1].c).toBeGreaterThan(1000);
  }, 40_000);

  it("gtimg 批量可取，代码与请求一致", async () => {
    resetClients();
    const c = createClient("tencent-live", { minIntervalMs: 400 });
    const codes = ["601012", "000001", "300750", "688981", "600519"];
    const qs = await fetchGtimgBatch(c, codes);
    expect(qs.length).toBe(codes.length);
    expect(qs.map(q => q.code).sort()).toEqual([...codes].sort());
    for (const q of qs) expect(Number.isFinite(q.price)).toBe(true);
  }, 40_000);

  it("东财涨停池可取（当日）", async () => {
    resetClients();
    const c = createClient("em-live", { minIntervalMs: 600, cooldownMs: 30_000 });
    const rows = await fetchZtPool(c, shanghaiToday().replace(/-/g, ""));
    expect(Array.isArray(rows)).toBe(true);
    // 交易日盘中/盘后通常非空；非交易日为空数组也算通过
    for (const r of rows) {
      expect(r.code).toMatch(/^\d{6}$/);
      expect(Number.isFinite(r.lbc)).toBe(true);
    }
  }, 60_000);
});
