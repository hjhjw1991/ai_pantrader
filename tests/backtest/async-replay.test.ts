import { describe, expect, it } from "vitest";
import type { SignalCard, StrategyEngineInput } from "@/lib/contracts";
import { runBacktest, runBacktestAsync, ReplayAborted } from "@/lib/backtest/replay";
import {
  fakeTradingDays, makeBar, makeCard, makeConfig, makeSecurity, makeViewFactory,
} from "./helpers/fixtures";

/**
 * 异步驱动器。
 *
 * 存在理由是实测数字：0.38 秒/交易日，四年约 968 个交易日 ≈ 6 分钟，而 Node 是单线程的。
 * 同步跑满 6 分钟 = 这 6 分钟里整个网站冻住，页面打不开、SSE 心跳停摆。
 * 所以回放必须能一天一让，顺便把进度报出来、把取消收进去。
 *
 * 底线：异步驱动器和同步驱动器必须得出**逐字段相同**的结果 ——
 * 回测算错的表现是一条看起来很正常的净值曲线，是这套系统里最难发现的错。
 */

const D = fakeTradingDays("2026-03-02", 6);
const BARS = [
  makeBar("600000", D[0], 10, 10, 10, 10),
  makeBar("600000", D[1], 10, 10.6, 9.9, 10.5),
  makeBar("600000", D[2], 11, 11.5, 10.9, 11.2),
  makeBar("600000", D[3], 11.2, 11.5, 11, 11.4),
  makeBar("600000", D[4], 11.4, 11.6, 11.2, 11.5),
  makeBar("600000", D[5], 11.5, 11.7, 11.4, 11.6),
];
const CFG = makeConfig();
const noop = (input: StrategyEngineInput): SignalCard => makeCard(input.view.asOf, []);

const opts = () => ({
  from: D[0], to: D[5],
  viewFactory: makeViewFactory({
    tradingDays: D, bars: { "600000": BARS }, securities: [makeSecurity("600000", "测试股")],
  }),
  strategy: noop,
  config: CFG,
  initialCash: 100_000,
  generatedAt: "2026-08-03T22:00:00+08:00",
});

describe("runBacktestAsync", () => {
  it("结果与同步驱动器完全一致 —— 两条路算出不同的净值是最危险的分叉", async () => {
    const sync = runBacktest(opts());
    const async_ = await runBacktestAsync(opts());
    expect(async_.report).toEqual(sync.report);
    expect(async_.detail).toEqual(sync.detail);
  });

  it("每个交易日报一次进度，done 单调递增到 total", async () => {
    const seen: Array<{ done: number; total: number; date: string }> = [];
    await runBacktestAsync(opts(), { onProgress: p => seen.push({ ...p }) });
    expect(seen).toHaveLength(D.length);
    expect(seen.map(p => p.date)).toEqual(D);
    expect(seen.every((p, i) => p.done === i + 1)).toBe(true);
    expect(new Set(seen.map(p => p.total)).size).toBe(1);
    expect(seen[seen.length - 1].done).toBe(seen[0].total);
  });

  it("取消：抛 ReplayAborted，并带上跑到哪儿了", async () => {
    const signal = { aborted: false };
    await expect(
      runBacktestAsync(opts(), {
        signal,
        // 跑完第 2 天就按下取消
        onProgress: p => { if (p.done >= 2) signal.aborted = true; },
      })
    ).rejects.toThrow(ReplayAborted);
  });

  it("取消之后不再继续跑 —— 取消了还在烧 CPU 等于没取消", async () => {
    const signal = { aborted: false };
    let calls = 0;
    try {
      await runBacktestAsync(opts(), {
        signal,
        onProgress: p => { calls++; if (p.done >= 2) signal.aborted = true; },
      });
    } catch { /* 预期 */ }
    expect(calls).toBe(2);
  });

  it("一开始就是取消态：一天都不跑", async () => {
    let calls = 0;
    await expect(
      runBacktestAsync(opts(), { signal: { aborted: true }, onProgress: () => { calls++; } })
    ).rejects.toThrow(ReplayAborted);
    expect(calls).toBe(0);
  });

  it("中途就让出事件循环，不是跑完才让 —— 不让的话回测期间页面根本打不开", async () => {
    let ticked = false;
    let tickedByDay: number | null = null;
    // 用 setImmediate 而不是 setTimeout(0)：Node 的 0ms 定时器实际最少 1ms，
    // 而这个夹具 6 天跑完不到 1ms，计时器根本轮不上，测出来的会是假阴性
    setImmediate(() => { ticked = true; });
    await runBacktestAsync(opts(), {
      onProgress: p => { if (ticked && tickedByDay === null) tickedByDay = p.done; },
    });
    expect(ticked).toBe(true);
    // 关键：外部任务是在回测**还没跑完**的时候插进来的
    expect(tickedByDay).not.toBeNull();
    expect(tickedByDay!).toBeLessThan(D.length);
  });
});
