import { describe, expect, it } from "vitest";
import { relStrength } from "@/lib/ui/views";

/**
 * 相对强度 = 个股涨幅 − 全市场平均涨幅。
 *
 * latestQuotes 取的是逐票最新快照，停牌票拿到的是昨天那根；
 * 拿昨天的涨幅减今天的市场均值，会凭空算出"跑赢/跑输"。
 */
describe("relStrength", () => {
  const market = { ts: "2026-09-24 10:30:00.000", avgPct: -1.5 };

  it("同一交易日：个股涨幅减市场均值", () => {
    expect(relStrength({ ts: "2026-09-24 10:25:00.000", pct: -0.5 }, market)).toBeCloseTo(1.0, 9);
  });

  it("快照是昨天的（停牌）→ null，不拿昨天的涨幅比今天的市场", () => {
    expect(relStrength({ ts: "2026-09-23 15:00:00.000", pct: 9.98 }, market)).toBeNull();
  });

  it("没有快照 / 没有市场基准 / 涨幅不是数 → null", () => {
    expect(relStrength(undefined, market)).toBeNull();
    expect(relStrength({ ts: "2026-09-24 10:25:00.000", pct: 1 }, null)).toBeNull();
    expect(relStrength({ ts: "2026-09-24 10:25:00.000", pct: NaN }, market)).toBeNull();
  });
});
