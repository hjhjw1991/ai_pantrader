import { describe, expect, it } from "vitest";
import { DEFAULT_CONSTRAINTS } from "@/lib/contracts";
import type { PointInTimeView, SignalCard, StrategyEngineInput } from "@/lib/contracts";
import { enforceNoLookAhead, runBacktest } from "@/lib/backtest/replay";
import {
  fakeTradingDays, makeBar, makeCandidate, makeCard, makeConfig, makeSecurity, makeViewFactory,
} from "./helpers/fixtures";

const D = fakeTradingDays("2026-03-02", 6); // 03-02,03,04,05,06,09

/**
 * 主力样本：D1 收盘 10.5，D2 跳空开在 11。
 * 这个跳空是 look-ahead 的照妖镜 —— 用同 bar 收盘决策 + 同 bar 收盘成交，会以 10.5 成交；
 * 正确实现只能拿到次日开盘 11（含滑点 11.022）。
 */
const BARS = [
  makeBar("600000", D[0], 10, 10, 10, 10),
  makeBar("600000", D[1], 10, 10.6, 9.9, 10.5),
  makeBar("600000", D[2], 11, 11.5, 10.9, 11.2),
  makeBar("600000", D[3], 11.2, 11.5, 11, 11.4),
  makeBar("600000", D[4], 11.4, 11.6, 11.2, 11.5),
  makeBar("600000", D[5], 11.5, 11.7, 11.4, 11.6),
];

function baseData(over: Partial<Parameters<typeof makeViewFactory>[0]> = {}) {
  return {
    tradingDays: D,
    bars: { "600000": BARS },
    securities: [makeSecurity("600000", "测试股")],
    ...over,
  };
}

/** 只在 D1 收盘后发一次买入，半仓，次日开盘挂单 */
function buyOnceStrategy(asOfLog: string[] = []) {
  return (input: StrategyEngineInput): SignalCard => {
    asOfLog.push(input.view.asOf);
    if (input.view.asOf !== D[1]) return makeCard(input.view.asOf, []);
    return makeCard(input.view.asOf, [makeCandidate({ code: "600000", size: 0.5 })]);
  };
}

const CFG = makeConfig();

function run(opts: Partial<Parameters<typeof runBacktest>[0]> = {}) {
  return runBacktest({
    from: D[0], to: D[5],
    viewFactory: makeViewFactory(baseData()),
    strategy: buyOnceStrategy(),
    config: CFG,
    initialCash: 100_000,
    generatedAt: "2026-08-03T22:00:00+08:00",
    ...opts,
  });
}

describe("重放顺序：昨日决策、今日成交", () => {
  const out = run();

  it("成交价来自次日开盘，不是决策日收盘（look-ahead 照妖镜）", () => {
    expect(out.detail.trades).toHaveLength(1);
    const t = out.detail.trades[0];
    expect(t.decidedOn).toBe(D[1]);
    expect(t.filledOn).toBe(D[2]);
    expect(t.px).toBeCloseTo(11 * 1.002, 10);
    // 同 bar 收盘成交会是 10.5 —— 一旦实现退化成那样，这两条会红
    expect(t.px).not.toBeCloseTo(10.5, 3);
    expect(t.px).toBeGreaterThan(10.5);
  });

  it("成交量按决策日收盘价与目标仓位算，取整到一手", () => {
    // floor(100000*0.5 / 10.5 / 100)*100
    expect(out.detail.trades[0].qty).toBe(4700);
  });

  it("净值曲线：成交前是初始现金，成交日按当日收盘估值", () => {
    const eq = Object.fromEntries(out.report.equity.map((p) => [p.date, p.equity]));
    expect(eq[D[0]]).toBe(100_000);
    expect(eq[D[1]]).toBe(100_000);
    const cash = 100_000 - 11.022 * 4700 - 11.022 * 4700 * DEFAULT_CONSTRAINTS.feeRate;
    expect(eq[D[2]]).toBeCloseTo(cash + 4700 * 11.2, 6);
    const p2 = out.report.equity.find((p) => p.date === D[2])!;
    expect(p2.position).toBeCloseTo((4700 * 11.2) / p2.equity, 10);
    expect(out.report.equity[0].position).toBe(0);
  });

  it("策略每天只看到当日视图，asOf 序列 == 实际回放日", () => {
    const log: string[] = [];
    const o = run({ strategy: buyOnceStrategy(log) });
    expect(log).toEqual(o.detail.replayedDays);
    expect(log).toEqual(D);
  });

  it("决策日不早于成交日就是未来函数，直接抛错", () => {
    expect(() => enforceNoLookAhead(D[2], D[2])).toThrow(/未来函数/);
    expect(() => enforceNoLookAhead(D[3], D[2])).toThrow(/未来函数/);
    expect(() => enforceNoLookAhead(D[1], D[2])).not.toThrow();
  });

  it("最后一天产出的决策不会被执行，但要计数而不是丢掉", () => {
    const o = run({
      strategy: (input) => makeCard(input.view.asOf, [makeCandidate({ code: "600000", size: 0.5 })]),
    });
    expect(o.detail.unexecutedDecisions).toBeGreaterThan(0);
  });
});

describe("T+1 在引擎层也成立", () => {
  it("当日成交建仓，清仓最早只能在次日成交", () => {
    const out = run({
      strategy: (input: StrategyEngineInput): SignalCard => {
        if (input.positions.length > 0) {
          return makeCard(input.view.asOf, [], [makeCandidate({ code: "600000", action: "清仓", size: 0 })]);
        }
        if (input.view.asOf !== D[1]) return makeCard(input.view.asOf, []);
        return makeCard(input.view.asOf, [makeCandidate({ code: "600000", size: 0.5 })]);
      },
    });
    expect(out.detail.closed).toHaveLength(1);
    const c = out.detail.closed[0];
    expect(c.entryDate).toBe(D[2]);
    expect(c.exitDate).toBe(D[3]); // 不是 D[2]
    expect(c.holdDays).toBe(1);
    expect(c.qty).toBe(4700);
    // 11.2*0.998 卖出，扣双边费用后的净盈亏
    expect(c.exitPx).toBeCloseTo(11.2 * 0.998, 10);
    expect(c.pnl).toBeCloseTo(595.680444, 4);
  });

  it("减仓卖一半，取整到一手", () => {
    const out = run({
      strategy: (input: StrategyEngineInput): SignalCard => {
        if (input.view.asOf === D[1]) return makeCard(input.view.asOf, [makeCandidate({ code: "600000", size: 0.5 })]);
        if (input.view.asOf === D[3]) {
          return makeCard(input.view.asOf, [], [makeCandidate({ code: "600000", action: "减仓", size: 0 })]);
        }
        return makeCard(input.view.asOf, []);
      },
    });
    const sells = out.detail.trades.filter((t) => t.side === "sell");
    expect(sells).toHaveLength(1);
    expect(sells[0].qty).toBe(2300);
    expect(sells[0].filledOn).toBe(D[4]);
  });
});

describe("缺口日跳过、不插值（spec §10.5）", () => {
  const out = run({
    viewFactory: makeViewFactory(baseData({ gaps: { [D[2]]: ["kline_daily"] } })),
  });

  it("缺口日不回放、不成交、不产生净值点", () => {
    expect(out.detail.skippedDays).toEqual([D[2]]);
    expect(out.detail.replayedDays).not.toContain(D[2]);
    expect(out.report.equity.some((p) => p.date === D[2])).toBe(false);
    expect(out.detail.trades).toHaveLength(0);
  });

  it("缺口日待执行的决策被丢弃并计数，不静默顺延到后一天", () => {
    expect(out.detail.droppedDecisions).toBe(1);
  });

  it("缺口计入覆盖率报告", () => {
    expect(out.report.coverage.gapDays).toBe(1);
    expect(out.report.coverage.coverage).toBeLessThan(1);
  });
});

describe("幸存者偏差：标的池只来自 view.universe()（spec §10.2）", () => {
  const DELIST = "600001";
  const data = {
    tradingDays: D,
    bars: {
      "600000": BARS,
      [DELIST]: [
        makeBar(DELIST, D[0], 10, 10, 10, 10),
        makeBar(DELIST, D[1], 10, 10.6, 9.9, 10.5),
        makeBar(DELIST, D[2], 11, 11.5, 10.9, 11.2),
      ],
    },
    securities: [makeSecurity("600000"), makeSecurity(DELIST, "将退市", "主板", { delistDate: D[3] })],
  };

  const seen: Record<string, string[]> = {};
  const out = runBacktest({
    from: D[0], to: D[5],
    viewFactory: makeViewFactory(data),
    strategy: (input: StrategyEngineInput): SignalCard => {
      seen[input.view.asOf] = input.view.universe().map((s) => s.code);
      if (input.view.asOf !== D[1]) return makeCard(input.view.asOf, []);
      return makeCard(input.view.asOf, [makeCandidate({ code: DELIST, size: 0.5 })]);
    },
    config: CFG,
    initialCash: 100_000,
    generatedAt: "2026-08-03T22:00:00+08:00",
  });

  it("退市日之后该票从标的池消失", () => {
    expect(seen[D[2]]).toContain(DELIST);
    expect(seen[D[3]]).not.toContain(DELIST);
  });

  it("持仓票退市 → 按最后已知价强制清算，不许挂在账上继续估值", () => {
    expect(out.detail.delistLiquidations).toBe(1);
    const c = out.detail.closed.find((t) => t.code === DELIST);
    expect(c).toBeDefined();
    expect(c!.exitDate).toBe(D[3]);
    expect(c!.exitPx).toBeCloseTo(11.2 * 0.998, 10);
    expect(out.report.equity[out.report.equity.length - 1].position).toBe(0);
  });
});

describe("撮合被约束挡住时要留痕", () => {
  it("钱不够买一手 → 记 blocked，不悄悄按小数股成交", () => {
    const out = run({ initialCash: 900 });
    expect(out.detail.trades).toHaveLength(0);
    expect(out.detail.blocked.length).toBeGreaterThan(0);
    expect(out.detail.blocked[0].blockedBy).toBe("不足一手");
    expect(out.detail.blocked[0].date).toBe(D[1]);
  });

  it("一字板买不进 → blocked 记 涨停封板", () => {
    const bars = [
      makeBar("600000", D[0], 10, 10, 10, 10),
      makeBar("600000", D[1], 10, 10.6, 9.9, 10.5),
      // D2 一字板：开=高=低=收=11.55（10.5 的 +10%）
      makeBar("600000", D[2], 11.55, 11.55, 11.55, 11.55, 1_000_000, 100_000_000),
      ...BARS.slice(3),
    ];
    const out = run({
      viewFactory: makeViewFactory({
        tradingDays: D,
        bars: { "600000": bars },
        securities: [makeSecurity("600000")],
        zt: {
          [D[2]]: [{
            date: D[2], code: "600000", lbc: 1, sealAmt: 500_000_000, openTimes: 0,
            firstSealTs: null, lastSealTs: null, sector: "半导体",
          }],
        },
      }),
    });
    expect(out.detail.trades).toHaveLength(0);
    expect(out.detail.blocked.map((b) => b.blockedBy)).toContain("涨停封板");
  });
});

describe("报告封装", () => {
  const out = run();

  it("按契约填 BacktestReport", () => {
    expect(out.report.strategyId).toBe("test-strat");
    expect(out.report.strategyVersion).toBe("1.0.0");
    expect(out.report.range).toEqual({ from: D[0], to: D[5] });
    expect(out.report.constraints).toEqual(DEFAULT_CONSTRAINTS);
    expect(out.report.resultHash).toMatch(/^[0-9a-f]{64}$/);
    expect(out.report.metrics.trades).toBe(out.detail.closed.length);
  });

  it("6 天的样本必然退化：Calmar 记 0 且写明原因", () => {
    expect(out.report.metrics.calmar).toBe(0);
    expect(out.detail.degeneracy.length).toBeGreaterThan(0);
  });

  it("覆盖率报告的有效区间不是请求区间（复权断层，spec R1）", () => {
    expect(out.report.coverage.effectiveRange.from).toBe(D[0]); // 2026 年在断层之后
    expect(out.detail.coverage.truncatedDays).toBe(0);
  });

  it("视图工厂拿到的 asOf 永远是当日，越界访问会被替身抛错", () => {
    // 替身自己会拦未来访问，这里确认引擎没有绕过它去要未来数据
    const factory = makeViewFactory(baseData());
    const v: PointInTimeView = factory(D[1]);
    expect(() => v.ztPool(D[2])).toThrow(/未来函数/);
    expect(v.dailyBars("600000", 10).map((b) => b.date)).toEqual([D[0], D[1]]);
  });
});
