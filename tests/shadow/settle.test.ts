/**
 * 影子盘结算：按止损 / 目标价模拟离场（用户 2026-09-23 选定的口径）。
 *
 *   - 次日一天内够到触发价才成交，价 = min(开盘, 触发价)
 *   - T+1：买入当天不能卖，止损 / 目标最早从第 2 天起判
 *   - 跳空开在止损下方 / 目标上方 → 按开盘价出（真实会发生的滑价）
 *   - 同一天止损和目标都碰到 → 按止损算（不知道盘中先后，取保守）
 *   - 都没碰到 → 第 H 天收盘出
 *   - 一字跌停卖不出 → 顺延到下一个能卖的交易日
 *   - 除权：之后的 K 线按复权因子换算到成交日的价格尺度
 */
import { describe, it, expect } from "vitest";
import { settleShadow } from "@/lib/shadow/settle";
import type { DailyBar } from "@/lib/contracts";

const ds = ["2026-09-01", "2026-09-02", "2026-09-03", "2026-09-04", "2026-09-07", "2026-09-08", "2026-09-09", "2026-09-10"];
const b = (i: number, o: number, h: number, l: number, c: number, adj = 1): DailyBar =>
  ({ code: "600000", date: ds[i], o, h, l, c, vol: 1, amount: 1, adjFactor: adj });
const NOCOST = { slippage: 0, feeRate: 0 };
const P = { triggerPx: 10, stopPx: 9.5, targetPx: 11 };

describe("settleShadow", () => {
  it("次日够不到触发价 → 未触发", () => {
    const r = settleShadow(P, [b(0, 10.3, 10.5, 10.1, 10.4)], { horizon: 5, ...NOCOST });
    expect(r.status).toBe("未触发");
  });

  it("次日没有 K 线（停牌 / 缺数据）→ 待定，不当成未触发", () => {
    expect(settleShadow(P, [], { horizon: 5, ...NOCOST }).status).toBe("待定");
  });

  it("低开时按开盘价成交", () => {
    const bars = [b(0, 9.8, 10.2, 9.7, 10), b(1, 10, 10.1, 9.9, 10), b(2, 10, 10.1, 9.9, 10), b(3, 10, 10.1, 9.9, 10), b(4, 10, 10.1, 9.9, 10.2)];
    const r = settleShadow(P, bars, { horizon: 5, ...NOCOST });
    expect(r.entryPx).toBe(9.8);
    expect(r.exitReason).toBe("期满");
    expect(r.exitPx).toBe(10.2);
    expect(r.grossPct).toBeCloseTo((10.2 / 9.8 - 1) * 100, 6);
  });

  it("第 2 天盘中碰到目标 → 按目标价出", () => {
    const bars = [b(0, 10, 10.2, 9.9, 10.1), b(1, 10.2, 11.2, 10.1, 10.9)];
    const r = settleShadow(P, bars, { horizon: 5, ...NOCOST });
    expect(r.exitReason).toBe("目标");
    expect(r.exitPx).toBe(11);
    expect(r.exitDate).toBe(ds[1]);
  });

  it("T+1：买入当天就跌破止损也卖不掉，次日开盘仍在止损下方 → 按次日开盘出", () => {
    const bars = [b(0, 10, 10.1, 9.3, 9.4), b(1, 9.2, 9.6, 9.0, 9.5)];
    const r = settleShadow(P, bars, { horizon: 5, ...NOCOST });
    expect(r.exitReason).toBe("止损");
    expect(r.exitPx).toBe(9.2);
    expect(r.exitDate).toBe(ds[1]);
  });

  it("跳空高开在目标上方 → 按开盘价出（比目标更好）", () => {
    const bars = [b(0, 10, 10.2, 9.9, 10.1), b(1, 11.5, 11.8, 11.3, 11.6)];
    const r = settleShadow(P, bars, { horizon: 5, ...NOCOST });
    expect(r.exitReason).toBe("目标");
    expect(r.exitPx).toBe(11.5);
  });

  it("同一天止损和目标都碰到 → 按止损（不知道盘中先后，取保守）", () => {
    const bars = [b(0, 10, 10.2, 9.9, 10.1), b(1, 10.1, 11.2, 9.4, 10)];
    const r = settleShadow(P, bars, { horizon: 5, ...NOCOST });
    expect(r.exitReason).toBe("止损");
    expect(r.exitPx).toBe(9.5);
  });

  it("一字跌停卖不出 → 顺延到下一个能卖的日子，按那天开盘出", () => {
    const bars = [b(0, 10, 10.1, 9.9, 10), b(1, 9, 9, 9, 9), b(2, 8.5, 8.9, 8.2, 8.6)];
    const r = settleShadow(P, bars, { horizon: 5, ...NOCOST });
    expect(r.exitReason).toBe("止损");
    expect(r.exitDate).toBe(ds[2]);
    expect(r.exitPx).toBe(8.5);
    expect(r.note).toMatch(/一字跌停/);
  });

  it("没有止损 / 目标价 → 只按期满收盘出", () => {
    const bars = [b(0, 10, 10.1, 9.9, 10), b(1, 9, 9.2, 8, 8.1), b(2, 8, 8.2, 7.9, 8), b(3, 8, 8.2, 7.9, 8), b(4, 8, 8.2, 7.9, 8.3)];
    const r = settleShadow({ triggerPx: 10, stopPx: null, targetPx: null }, bars, { horizon: 5, ...NOCOST });
    expect(r.exitReason).toBe("期满");
    expect(r.exitPx).toBe(8.3);
  });

  it("持有期没走完 → 待定（不拿半截结果结算）", () => {
    const bars = [b(0, 10, 10.1, 9.9, 10), b(1, 10, 10.1, 9.9, 10)];
    expect(settleShadow(P, bars, { horizon: 5, ...NOCOST }).status).toBe("待定");
  });

  it("除权：之后的 K 线换算到成交日尺度（10 送 10 后价格腰斩不是亏了一半）", () => {
    const bars = [b(0, 10, 10.1, 9.9, 10, 1), b(1, 5, 5.05, 4.95, 5, 2), b(2, 5, 5.05, 4.95, 5, 2), b(3, 5, 5.05, 4.95, 5, 2), b(4, 5, 5.1, 4.95, 5.1, 2)];
    const r = settleShadow(P, bars, { horizon: 5, ...NOCOST });
    expect(r.exitReason).toBe("期满");
    expect(r.exitPx).toBeCloseTo(10.2, 6);
    expect(r.grossPct).toBeCloseTo(2, 6);
  });

  it("成交日恰好除权：计划价按复权因子换算，不会凭空多出一笔成交", () => {
    // 基准日因子 1，成交日 10 送 10（因子 2）：原始价从 10 附近跳到 5 附近
    const bars = [b(0, 5.2, 5.3, 5.15, 5.25, 2)];
    expect(settleShadow(P, bars, { horizon: 5, ...NOCOST }).status).toBe("待定");   // 不换算：5.15 ≤ 10 被当成成交
    expect(settleShadow(P, bars, { horizon: 5, ...NOCOST, baseAdjFactor: 1 }).status).toBe("未触发"); // 触发价换算成 5
  });

  it("成本：买卖各一次滑点与费率", () => {
    const bars = [b(0, 10, 10.1, 9.9, 10), b(1, 10, 10.1, 9.9, 10), b(2, 10, 10.1, 9.9, 10), b(3, 10, 10.1, 9.9, 10), b(4, 10, 10.1, 9.9, 10)];
    const r = settleShadow(P, bars, { horizon: 5, slippage: 0.002, feeRate: 0.0013 });
    const buy = 10 * 1.002 * 1.0013, sell = 10 * 0.998 * (1 - 0.0013);
    expect(r.grossPct).toBe(0);
    expect(r.netPct).toBeCloseTo((sell / buy - 1) * 100, 6);
  });

  it("MFE / MAE 从成交日到离场日，相对成交价", () => {
    const bars = [b(0, 10, 10.3, 9.8, 10), b(1, 10, 10.6, 9.7, 10.2), b(2, 10.2, 10.4, 10, 10.1), b(3, 10.1, 10.2, 10, 10.1), b(4, 10.1, 10.2, 10, 10.1)];
    const r = settleShadow(P, bars, { horizon: 5, ...NOCOST });
    expect(r.mfePct).toBeCloseTo(6, 6);
    expect(r.maePct).toBeCloseTo(-3, 6);
  });
});
