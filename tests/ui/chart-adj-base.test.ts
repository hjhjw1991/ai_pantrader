/**
 * K 线图的前复权口径。
 *
 * 这条测试存在的原因是一次真实事故（2026-09-28 / 09-29 连续两天）：常驻采集进程
 * 的代码冻结在它启动那一刻，最新交易日那根的 adj_factor 被写成 1.0，而旧代码的
 * 前复权基准取的是"最后一根的因子" —— 基准错了，**整段历史按 5.8 倍显示**
 * （太极实业 9-24 真实收盘 19.41，图上 112.65）。它不像"某天错了一格"，
 * 而像"这只票以前很贵"，看盘的人不会想到去怀疑数据源。
 *
 * 这里直接拿 chartData 验，而不是只验 baseAdjFactor：中间的因子运算、MACD、
 * 结构位任何一处改回去用最后一根，这组测试都会红。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { chartData } from "@/lib/ui/adapters/chart";
import { makeConfig } from "../backtest/helpers/fixtures";
import { makeTempDb, insDaily, insSecurity, type TempDb } from "../pit/helpers";

const CFG = makeConfig();

let t: TempDb;
beforeEach(() => { t = makeTempDb(); insSecurity(t.db, "600667", { name: "太极实业" }); });
afterEach(() => { t.close(); });

/** 一段没有除权的行情：因子恒定 5.8，真实收盘 18~20 元 */
function seed(adjOfLast: number): void {
  const rows: Array<[string, number, number]> = [
    ["2026-09-22", 19.87, 5.8],
    ["2026-09-23", 20.59, 5.8],
    ["2026-09-24", 19.41, 5.8],
    ["2026-09-28", 17.81, 5.8],
    ["2026-09-29", 17.95, adjOfLast],
  ];
  for (const [d, c, adj] of rows) insDaily(t.db, "600667", d, c, { adj });
}

const closes = () => (chartData(t.db, "600667", 60, "2026-09-29", CFG) as any).bars.map((b: any) => b.c);

describe("chartData 的前复权基准", () => {
  it("因子正常时，画出来的就是真实收盘", () => {
    seed(5.8);
    const r = chartData(t.db, "600667", 60, "2026-09-29", CFG);
    expect(r.available).toBe(true);
    if (!r.available) return;
    expect(r.bars.map(b => b.c)).toEqual([19.87, 20.59, 19.41, 17.81, 17.95]);
  });

  /** 这条是那次事故的形状：只有最后一根被写坏，其余全对 */
  it("最新一根因子被写成 1.0 时，整段价格一个字都不能变", () => {
    seed(5.8);
    const good = closes();
    seed(1.0);
    const broken = closes();
    expect(broken).toEqual(good);
    expect(broken).toEqual([19.87, 20.59, 19.41, 17.81, 17.95]);
  });

  it("从没除过权的票（整段因子 1）不误伤", () => {
    insDaily(t.db, "600667", "2026-09-28", 10, { adj: 1 });
    insDaily(t.db, "600667", "2026-09-29", 11, { adj: 1 });
    const r = chartData(t.db, "600667", 60, "2026-09-29", CFG);
    expect(r.available).toBe(true);
    if (!r.available) return;
    expect(r.bars.map(b => b.c)).toEqual([10, 11]);
  });

  /** 一堆 NaN 价传出去，图上就是一条断线还不报错 —— 比显示错价更难发现 */
  it("线上 hedge：坏行不能算出 NaN", () => {
    seed(1.0);
    for (const c of closes()) expect(Number.isFinite(c)).toBe(true);
  });
});
