import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_CONSTRAINTS } from "@/lib/contracts";
import type { SignalCard, StrategyEngineInput } from "@/lib/contracts";
import { canonicalJson, computeResultHash } from "@/lib/backtest/hash";
import { runBacktest } from "@/lib/backtest/replay";
import type { RunBacktestOptions } from "@/lib/backtest/replay";
import {
  fakeTradingDays, makeBar, makeCandidate, makeCard, makeConfig, makeSecurity, makeViewFactory,
} from "./helpers/fixtures";

const D = fakeTradingDays("2026-03-02", 12);

/** 一段有涨有跌的行情，够产生多笔往返 */
const closes = [10, 10.5, 11.2, 10.8, 10.2, 10.6, 11.4, 11.1, 10.5, 10.9, 11.6, 11.3];
const bars = D.map((d, i) =>
  makeBar("600000", d, closes[i] * 0.99, closes[i] * 1.02, closes[i] * 0.97, closes[i])
);

/** 低买高卖：收盘低于 10.6 买、高于 11.1 清 —— 有确定性、无随机 */
function seesawStrategy(input: StrategyEngineInput): SignalCard {
  const last = input.view.dailyBars("600000", 1)[0];
  if (!last) return makeCard(input.view.asOf, []);
  if (input.positions.length > 0 && last.c > 11.1) {
    return makeCard(input.view.asOf, [], [makeCandidate({ code: "600000", action: "清仓", size: 0 })]);
  }
  if (input.positions.length === 0 && last.c < 10.6) {
    return makeCard(input.view.asOf, [makeCandidate({ code: "600000", size: 0.6 })]);
  }
  return makeCard(input.view.asOf, []);
}

function opts(over: Partial<RunBacktestOptions> = {}): RunBacktestOptions {
  return {
    from: D[0], to: D[D.length - 1],
    viewFactory: makeViewFactory({
      tradingDays: D, bars: { "600000": bars }, securities: [makeSecurity("600000")],
    }),
    strategy: seesawStrategy,
    config: makeConfig(),
    initialCash: 200_000,
    generatedAt: "2026-08-03T22:00:00+08:00",
    ...over,
  };
}

describe("可复现性（spec §17 断言 4）", () => {
  it("同一份历史输入跑两次，结果哈希一致", () => {
    const a = runBacktest(opts());
    const b = runBacktest(opts());
    expect(a.detail.trades.length).toBeGreaterThan(0); // 空回测的哈希相等毫无意义
    expect(a.report.resultHash).toBe(b.report.resultHash);
    expect(a.report.equity).toEqual(b.report.equity);
    expect(a.detail.trades).toEqual(b.detail.trades);
    expect(a.detail.closed).toEqual(b.detail.closed);
  });

  it("报告生成时间不进哈希 —— 否则这条断言永远过不了", () => {
    const a = runBacktest(opts({ generatedAt: "2026-08-03T22:00:00+08:00" }));
    const b = runBacktest(opts({ generatedAt: "2027-01-01T09:00:00+08:00" }));
    expect(a.report.resultHash).toBe(b.report.resultHash);
    expect(a.detail.generatedAt).not.toBe(b.detail.generatedAt);
  });

  it("换了约束就是换了实验条件，哈希必须变", () => {
    const base = runBacktest(opts()).report.resultHash;
    expect(runBacktest(opts({ constraints: { ...DEFAULT_CONSTRAINTS, slippage: 0.005 } })).report.resultHash).not.toBe(base);
    expect(runBacktest(opts({ constraints: { ...DEFAULT_CONSTRAINTS, t1: false } })).report.resultHash).not.toBe(base);
    expect(runBacktest(opts({ initialCash: 200_001 })).report.resultHash).not.toBe(base);
    expect(runBacktest(opts({ config: makeConfig({ version: "1.0.1" }) })).report.resultHash).not.toBe(base);
  });

  it("哈希是 sha256 十六进制，且与键书写顺序无关", () => {
    expect(runBacktest(opts()).report.resultHash).toMatch(/^[0-9a-f]{64}$/);
    expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }));
    expect(computeResultHash({ x: 1, y: [1, 2] })).toBe(computeResultHash({ y: [1, 2], x: 1 }));
  });

  it("浮点末位抖动不改哈希（固定 10 位入哈希）", () => {
    expect(computeResultHash({ v: 0.1 + 0.2 })).toBe(computeResultHash({ v: 0.3 }));
  });

  it("lib/backtest 里不许出现 Date.now / Math.random（重放路径必须纯）", () => {
    const dir = join(process.cwd(), "lib/backtest");
    const hits: string[] = [];
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".ts")) continue;
      const src = readFileSync(join(dir, f), "utf8");
      // 注释里提到这两个名字是允许的（就是在解释为什么不能用），只查真实调用
      for (const line of src.split("\n")) {
        const code = line.replace(/\/\/.*$/, "").replace(/^\s*\*.*$/, "");
        if (/Date\.now\s*\(|Math\.random\s*\(|new Date\s*\(/.test(code)) hits.push(`${f}: ${line.trim()}`);
      }
    }
    expect(hits).toEqual([]);
  });
});
