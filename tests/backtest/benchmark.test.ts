import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb } from "@/lib/db";
import { runMigrations } from "@/lib/db/migrate";
import {
  DEFAULT_BENCHMARK, benchmarkName, isKnownBenchmark,
  loadBenchmark, loadBenchmarkWithStats, benchmarkStats,
} from "@/lib/backtest/benchmark";
import { annualiseOf, maxDrawdownOf } from "@/lib/backtest/series";
import { maxDrawdown } from "@/lib/backtest/metrics";
import { renderTearsheet } from "@/lib/backtest/tearsheet";
import type { EquityPoint } from "@/lib/contracts/backtest";

/**
 * 基准对比。
 *
 * 这个文件里真正要紧的只有一件事：**对齐口径**。
 * 基准必须以策略的交易日为 x 轴 —— 指数日历常常更长（多出来的十几天
 * 正是策略的数据缺口日；具体差几天随区间与采集进度变，不在这里写死）。
 * 各画各的日历就错位，而错位看起来完全正常：峰值对不上、拐点差几天，
 * 读者只会以为"策略某段跑输了"，不会想到是轴不同。
 *
 * 所以对齐全靠构造出来的**陷阱序列**验证：让策略没交易的那几天指数暴涨，
 * 若实现按位置顺序取数而不是按日期取，结果会明显不同。
 */

let dir: string, db: ReturnType<typeof openDb>;

function putKline(code: string, rows: Array<[string, number]>): void {
  const stmt = db.prepare(
    `INSERT OR REPLACE INTO kline_daily (code, date, o, h, l, c, vol, amount, adj_factor)
     VALUES (?, ?, ?, ?, ?, ?, 0, 0, 1.0)`
  );
  for (const [d, c] of rows) stmt.run(code, d, c, c, c, c);
}

/** 净值序列：给一组净值数，日期用 d1..dn */
function equityOf(vals: number[], dates?: string[]): EquityPoint[] {
  return vals.map((v, i) => ({
    date: dates?.[i] ?? `2026-01-${String(i + 1).padStart(2, "0")}`,
    equity: v,
    position: 0,
  }));
}

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "pt-bench-"));
  db = openDb(path.join(dir, "t.db"));
  runMigrations(db);
});
/**
 * 每个用例都从空表开始。
 *
 * `INSERT OR REPLACE` 是按 (code,date) 替换，前一条用例写过的日期**不会消失** ——
 * 于是"这一格本来该缺"的用例会拿到上一条留下的值，missingDays 变成 0 而一切照过。
 * 这类污染不会报错，只会让用例测到别的用例的数据。
 */
beforeEach(() => {
  db.exec("DELETE FROM kline_daily");
});
afterAll(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("对齐：以策略的交易日为 x 轴", () => {
  /**
   * 策略只有 2 个净值点（01-01 与 01-04），中间两天是它的数据缺口，
   * 而指数这四天都有行情，且**策略没交易的中间两天暴涨到 300**。
   *
   * 按日期取 → 基准只用 01-01 与 01-04，结果是 100 → 101。
   * 按位置取 → 基准会取指数的前两天 01-01、01-02，其中第二天是 300，
   * 结果整个不同 —— 而它看起来完全正常，图也照画。
   */
  it("策略缺的那些天，指数再涨也不许进基准序列", () => {
    const dates = ["2026-01-01", "2026-01-04"];
    const eq = equityOf([100, 101], dates);
    putKline("sh000300", [
      ["2026-01-01", 100], ["2026-01-02", 300], ["2026-01-03", 300], ["2026-01-04", 101],
    ]);

    const s = loadBenchmark(db, "sh000300", eq);
    expect(s).not.toBeNull();
    expect(s!.equity.length).toBe(2);          // 与策略同长，不是指数的 4
    expect(s!.availableDays).toBe(4);          // 区间内指数自己有 4 天
    expect(s!.missingDays).toBe(0);
    // 归一到策略初始资金 100：01-01 收 100、01-04 收 101
    expect(s!.equity[0]).toBeCloseTo(100, 6);
    expect(s!.equity[1]).toBeCloseTo(101, 6);  // 若按位置取，这里会是 300 归一后的数
  });

  it("丢弃的天数要报出来，好让报告写明", () => {
    // 区间 02-02~02-05，指数这 4 天都有，策略只有头尾两天 → 丢 2 天
    const eq = equityOf([100, 101], ["2026-02-02", "2026-02-05"]);
    putKline("sh000300", [
      ["2026-02-02", 100], ["2026-02-03", 150], ["2026-02-04", 150], ["2026-02-05", 101],
    ]);
    const s = loadBenchmark(db, "sh000300", eq)!;
    expect(s.availableDays).toBe(4);
    expect(s.equity.length).toBe(2);
    expect(s.missingDays).toBe(0);
    expect(s.availableDays - (s.equity.length - s.missingDays)).toBe(2);
  });
});

describe("缺数据：记 null，不许插值", () => {
  it("策略有而基准没有的那天是 null，不是前值也不是 0", () => {
    const eq = equityOf([100, 101, 102, 103]);
    putKline("sh000300", [
      ["2026-01-01", 100], ["2026-01-02", 101],
      /* 01-03 缺 */
      ["2026-01-04", 103],
    ]);
    const s = loadBenchmark(db, "sh000300", eq)!;
    expect(s.missingDays).toBe(1);
    expect(s.equity[2]).toBeNull();
    expect(s.equity[1]).toBeCloseTo(101, 6);
    expect(s.equity[3]).toBeCloseTo(103, 6);
  });

  it("有缺口时统计只配对两边都有的天，不编零收益日", () => {
    const eq = equityOf([100, 101, 102, 103]);
    const bench = [100, 101, null, 103];
    const st = benchmarkStats(eq, bench)!;
    /**
     * 4 个净值点本有 3 对，缺口在下标 2，于是**两侧那两对一起失效**：
     * (1→2) 右端是缺口、(2→3) 左端是缺口。只剩 (0→1) 这一对。
     * 不能拿 (1→3) 凑成"两天合一天"的收益 —— 那会把两天的变动算进一个日频样本，
     * 波动、Beta、跟踪误差会一起失真。
     */
    expect(st.paired).toBe(1);
  });
});

describe("统计自洽", () => {
  it("基准与策略完全同形时：Beta=1、相关=1、超额=0、跟踪误差=0", () => {
    const eq = equityOf([100, 110, 99, 120]);
    const bench = [100, 110, 99, 120];
    const st = benchmarkStats(eq, bench)!;
    expect(st.beta).toBeCloseTo(1, 6);
    expect(st.correlation).toBeCloseTo(1, 6);
    expect(st.excessTotal).toBeCloseTo(0, 6);
    expect(st.excessAnnual).toBeCloseTo(0, 6);
    expect(st.trackingError).toBeCloseTo(0, 6);
    expect(st.benchMaxDD).toBeCloseTo((110 - 99) / 110, 6);
  });

  it("基准零波动时 Beta 无定义，记 null 而不是 Infinity", () => {
    const eq = equityOf([100, 110, 105]);
    const st = benchmarkStats(eq, [100, 100, 100])!;
    expect(st.beta).toBeNull();
    expect(st.alphaAnnual).toBeNull();
  });

  it("超额 = 策略 − 基准，与两端总收益对得上", () => {
    const eq = equityOf([100, 112]);
    const st = benchmarkStats(eq, [100, 104])!;
    expect(st.benchTotal).toBeCloseTo(0.04, 6);
    expect(st.excessTotal).toBeCloseTo(0.12 - 0.04, 6);
  });
});

describe("指数代码白名单", () => {
  it("默认基准是沪深300，且它确实在采集清单里", () => {
    expect(DEFAULT_BENCHMARK).toBe("sh000300");
    expect(isKnownBenchmark(DEFAULT_BENCHMARK)).toBe(true);
    expect(benchmarkName("sh000300")).toBe("沪深300");
  });

  it("瞎编一个代码要拒绝，而不是查不到就当没基准", () => {
    expect(isKnownBenchmark("sh999999")).toBe(false);
    const eq = equityOf([100, 101]);
    putKline("sh999999", [["2026-01-01", 100], ["2026-01-02", 101]]);
    const r = loadBenchmarkWithStats(db, "sh999999", eq);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("不是已采集日线");
  });

  it("区间内没有日线时给出原因，不静默", () => {
    const r = loadBenchmarkWithStats(db, "sh000300", equityOf([100, 101], ["2019-01-01", "2019-01-02"]));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("没有");
  });
});

describe("序列数学：三处共用同一份", () => {
  it("最大回撤：metrics 委托后与 series 给出同一个值", () => {
    const eq = equityOf([100, 120, 90, 130, 100]);
    expect(maxDrawdown(eq)).toBe(maxDrawdownOf(eq));
    expect(maxDrawdown(eq)).toBeCloseTo((120 - 90) / 120, 10);
  });

  it("年化：满一年线性涨 10% 就是 10%", () => {
    // 253 点 = 252 个区间，折算指数 252/252 = 1
    const eq = equityOf(Array.from({ length: 253 }, (_, i) => 100 + (10 * i) / 252));
    expect(annualiseOf(eq)).toBeCloseTo(0.1, 6);
  });

  it("年化：区间不足一年会放大，但函数不擅自判退化", () => {
    const eq = equityOf([100, 110]);   // 一天涨 10%，折算指数 252/1
    expect(annualiseOf(eq)).toBeCloseTo(Math.pow(1.1, 252) - 1, 6);
  });
});

describe("tearsheet 渲染", () => {
  const rep = (vals: number[]) => ({
    strategyId: "t", strategyVersion: "1", config: {} as any,
    range: { from: "2026-01-01", to: "2026-01-04" },
    constraints: { t1: true, limitUpUnbuyable: true, limitDownUnsellable: true,
      suspensionBlocks: true, slippage: 0.001, feeRate: 0.0003, minFee: 5 } as any,
    metrics: { calmar: 1, annualReturn: 0.1, maxDrawdown: 0.1, sharpe: 1, winRate: 0.5,
      profitFactor: 1.5, trades: 40, avgHoldDays: 3, triggerRate: 0.5, buyFilled: 20,
      buyDecisions: 40 } as any,
    equity: equityOf(vals),
    coverage: { coverage: 1, gapDays: 0, effectiveRange: { from: "2026-01-01", to: "2026-01-04" },
      lowConfidenceFactors: [] } as any,
    resultHash: "h",
  });

  it("没传基准也没有原因时，不出现这一块", () => {
    expect(renderTearsheet(rep([100, 110, 120, 130]) as any)).not.toContain("基准对比");
  });

  it("取了基准但没取成，要写明无基准，而不是整块消失", () => {
    const html = renderTearsheet(rep([100, 110, 120, 130]) as any, {
      benchmarkReason: "区间内没有沪深300 的日线",
    });
    expect(html).toContain("基准对比");
    expect(html).toContain("无基准");
  });

  it("有基准时画出来，且基准线落在图区内（量程必须框住基准）", () => {
    const eq = equityOf([100, 101, 102, 103]);
    // 基准一路涨到远高于策略：只按策略定量程的话，基准线会被裁在图框外
    const series = { code: "sh000300", name: "沪深300",
      equity: [100, 140, 180, 220], missingDays: 0, availableDays: 4 };
    const stats = benchmarkStats(eq, series.equity)!;
    const html = renderTearsheet(rep([100, 101, 102, 103]) as any, {
      benchmark: { series, stats },
    });
    expect(html).toContain("基准对比");
    expect(html).toContain("沪深300");

    // 图区上沿 16、净值区高 186 → 所有点必须落在 [16, 202]
    const m = html.match(/<polyline class="bm" points="([^"]+)"/);
    expect(m).not.toBeNull();
    const ys = m![1].split(" ").map(p => Number(p.split(",")[1]));
    expect(Math.min(...ys)).toBeGreaterThanOrEqual(16);
    expect(Math.max(...ys)).toBeLessThanOrEqual(202);
    // 且确实有起伏 —— 被压成一条直线说明量程没算进去
    expect(Math.max(...ys) - Math.min(...ys)).toBeGreaterThan(50);
  });

  it("基准有缺口时，线断成多段而不是一条直线跨过去", () => {
    const eq = equityOf([100, 101, 102, 103, 104]);
    const series = { code: "sh000300", name: "沪深300",
      equity: [100, 101, null, 103, 104] as Array<number | null>,
      missingDays: 1, availableDays: 5 };
    const stats = benchmarkStats(eq, series.equity)!;
    const html = renderTearsheet(rep([100, 101, 102, 103, 104]) as any, {
      benchmark: { series, stats },
    });
    const segs = html.match(/<polyline class="bm"/g) ?? [];
    expect(segs.length).toBe(2);   // null 把它切成两段
    expect(html).toContain("未插值");
  });
});

describe("策略首日缺指数：对齐到第一个共同交易日，而不是整块基准消失", () => {
  it("首日缺 → 从第二天起算、归一到策略当天净值，首日记 null", () => {
    const eq = equityOf([100, 110, 121, 133.1]);
    putKline("sh000300", [
      /* 01-01 缺 */
      ["2026-01-02", 200], ["2026-01-03", 210], ["2026-01-04", 220],
    ]);
    const r = loadBenchmarkWithStats(db, "sh000300", eq);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.series.alignedFrom).toBe("2026-01-02");
    expect(r.series.equity[0]).toBeNull();
    expect(r.series.missingDays).toBe(1);
    // 归一到策略在 01-02 的净值 110，而不是首日的 100
    expect(r.series.equity[1]).toBeCloseTo(110, 6);
    expect(r.series.equity[3]).toBeCloseTo(110 * 220 / 200, 6);
    // 超额用同一段区间：策略 01-02→01-04 = 133.1/110 − 1 = 21%，基准 10%
    expect(r.stats.benchTotal).toBeCloseTo(0.1, 6);
    expect(r.stats.excessTotal).toBeCloseTo(133.1 / 110 - 1 - 0.1, 6);
  });

  it("首日对得上时不出现 alignedFrom（旧行为不变）", () => {
    const eq = equityOf([100, 101]);
    putKline("sh000300", [["2026-01-01", 100], ["2026-01-02", 101]]);
    expect(loadBenchmark(db, "sh000300", eq)!.alignedFrom).toBeUndefined();
  });

  it("区间内有日线但一天都对不上：原因写明，不说成「没有日线」", () => {
    const eq = equityOf([100, 101, 102], ["2026-03-02", "2026-03-04", "2026-03-06"]);
    putKline("sh000300", [["2026-03-03", 100], ["2026-03-05", 101]]);
    const r = loadBenchmarkWithStats(db, "sh000300", eq);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toContain("没有一天重合");
      expect(r.reason).toContain("2 天");
    }
  });

  it("报告里写明基准从哪天起算", () => {
    const eq = equityOf([100, 110, 121, 133.1]);
    putKline("sh000300", [["2026-01-02", 200], ["2026-01-03", 210], ["2026-01-04", 220]]);
    const r = loadBenchmarkWithStats(db, "sh000300", eq);
    if (!r.ok) throw new Error(r.reason);
    const html = renderTearsheet({
      strategyId: "t", strategyVersion: "1", config: {} as any,
      range: { from: "2026-01-01", to: "2026-01-04" },
      constraints: { t1: true, limitUpUnbuyable: true, limitDownUnsellable: true,
        suspensionBlocks: true, slippage: 0.001, feeRate: 0.0003, minFee: 5 } as any,
      metrics: { calmar: 1, annualReturn: 0.1, maxDrawdown: 0.1, sharpe: 1, winRate: 0.5,
        profitFactor: 1.5, trades: 40, avgHoldDays: 3, triggerRate: 0.5, buyFilled: 20,
        buyDecisions: 40 } as any,
      equity: eq,
      coverage: { coverage: 1, gapDays: 0, effectiveRange: { from: "2026-01-01", to: "2026-01-04" },
        lowConfidenceFactors: [] } as any,
      resultHash: "h",
    } as any, { benchmark: { series: r.series, stats: r.stats } });
    expect(html).toContain("第一个共同交易日 2026-01-02");
  });
});

describe("基准名只转义一次", () => {
  it("名字里带 & / <：印成 &amp; / &lt;，不是 &amp;amp;", () => {
    const eq = equityOf([100, 101, 102]);
    const series = { code: "sh000300", name: "A&B<指数>", equity: [100, 101, 102], missingDays: 0, availableDays: 3 };
    const stats = benchmarkStats(eq, series.equity)!;
    const html = renderTearsheet({
      strategyId: "t", strategyVersion: "1", config: {} as any,
      range: { from: "2026-01-01", to: "2026-01-03" },
      constraints: { t1: true, limitUpUnbuyable: true, limitDownUnsellable: true,
        suspensionBlocks: true, slippage: 0.001, feeRate: 0.0003, minFee: 5 } as any,
      metrics: { calmar: 1, annualReturn: 0.1, maxDrawdown: 0.1, sharpe: 1, winRate: 0.5,
        profitFactor: 1.5, trades: 40, avgHoldDays: 3, triggerRate: 0.5, buyFilled: 20,
        buyDecisions: 40 } as any,
      equity: eq,
      coverage: { coverage: 1, gapDays: 0, effectiveRange: { from: "2026-01-01", to: "2026-01-03" },
        lowConfidenceFactors: [] } as any,
      resultHash: "h",
    } as any, { benchmark: { series, stats } });
    expect(html).toContain("A&amp;B&lt;指数&gt; 买入持有");
    expect(html).not.toContain("&amp;amp;");
    expect(html).not.toContain("&amp;lt;");
  });
});
