import { describe, it, expect } from "vitest";
import { completeDate } from "@/lib/pit/complete-date";
import type { PointInTimeView } from "@/lib/contracts";

/**
 * 「数据完整的最近交易日」。
 *
 * 起因是实测出来的一个整段失效：当天日线要等 22:00 的夜间全量拉取才落库，
 * 所以盘中「今天」这一格是空的 —— marketBreadth 要求 `bar.date === 评估日`，
 * 于是全市场 5,888 只票全部落进 unknown，涨跌家数归零，盘面强度退回占位值 50，
 * 低于进攻阈值 65，**档位整个交易日卡在中性、候选池恒为空**。
 *
 * 同一个库的对照（只改 asOf）：
 *   asOf=2026-08-26 15:30 → 进攻 / 2 只候选 / 盘面强度 66.2
 *   asOf=2026-08-27 任意时刻 → 中性 / 0 候选 / 盘面强度 50
 * 分水岭是 09:35：第一轮盘中采集把今天写进交易日历，评估日随即从昨天翻成今天。
 *
 * 所以横截面因子要评估的是**最近一个数据已经完整的交易日**，而不是一个还没有数据的今天。
 * 判定用指数日线：它是全市场里最不可能停牌的一条序列，且盘面强度本来就在读它。
 */

/** 造一个只有 dailyBars/universe 的假视图：完整性判据只用得到这两个 */
function viewWith(bars: string[], asOf: string, codes = ["600000", "600001", "600002"]): PointInTimeView {
  return {
    asOf,
    universe: () => codes.map(code => ({ code, name: code, listDate: null, delistDate: null, board: "主板", isStHistory: false })),
    dailyBars(code: string, n: number) {
      return bars.slice(-n).map(d => ({
        code, date: d, o: 1, h: 1, l: 1, c: 1, vol: 1, amount: 1, adjFactor: 1,
      }));
    },
  } as unknown as PointInTimeView;
}

describe("completeDate", () => {
  it("今天的日线已经落库 → 就用今天", () => {
    const v = viewWith(["2026-08-25", "2026-08-26", "2026-08-27"], "2026-08-27 22:30:00");
    expect(completeDate(v, "2026-08-27")).toBe("2026-08-27");
  });

  it("盘中今天还没落库 → 退到最近一个有数据的交易日", () => {
    const v = viewWith(["2026-08-25", "2026-08-26"], "2026-08-27 10:50:00");
    expect(completeDate(v, "2026-08-27")).toBe("2026-08-26");
  });

  it("传进来的是带时分秒的 asOf 也要认 —— evalDate 默认就把整个时间戳交出来", () => {
    const v = viewWith(["2026-08-25", "2026-08-26"], "2026-08-27 10:50:00");
    expect(completeDate(v, "2026-08-27 10:50:00.000")).toBe("2026-08-26");
  });

  it("回放历史某天时不改日期 —— 那天的数据是完整的，不能悄悄退一天", () => {
    const v = viewWith(["2026-08-25", "2026-08-26"], "2026-08-26");
    expect(completeDate(v, "2026-08-26")).toBe("2026-08-26");
  });

  it("一根日线都取不到 → 原样返回，不猜", () => {
    const v = viewWith([], "2026-08-27 10:50:00");
    expect(completeDate(v, "2026-08-27")).toBe("2026-08-27");
  });

  it("宇宙为空（空库）→ 原样返回", () => {
    const v = viewWith(["2026-08-26"], "2026-08-27 10:50:00", []);
    expect(completeDate(v, "2026-08-27")).toBe("2026-08-27");
  });

  it("周末/非交易日问过来 → 给最近有数据的那天", () => {
    const v = viewWith(["2026-08-25", "2026-08-26"], "2026-08-29 10:00:00");
    expect(completeDate(v, "2026-08-29")).toBe("2026-08-26");
  });
});
