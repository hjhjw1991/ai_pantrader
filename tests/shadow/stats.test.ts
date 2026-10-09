/**
 * 影子盘统计：每个变体一份成绩单，外加与 baseline 的差异检验。
 * 毕业门槛（④期3）直接读这里的数，口径必须钉死。
 */
import { describe, it, expect } from "vitest";
import { summarize, welch, maxDrawdown, dailyReturns, type Trade } from "@/lib/shadow/stats";

const tr = (net: number, over: Partial<Trade> = {}): Trade => ({
  status: "已结算", netPct: net, exitDate: "2026-09-01", exitReason: "期满", stage: null, baseDate: "2026-08-25", ...over,
});

describe("summarize", () => {
  it("胜率 = 净收益 > 0 的占比；触发率 = 已结算 / (已结算 + 未触发)", () => {
    const s = summarize([tr(2), tr(-1), tr(3), { ...tr(0), status: "未触发", netPct: null }]);
    expect(s.settled).toBe(3);
    expect(s.untriggered).toBe(1);
    expect(s.triggerRate).toBeCloseTo(0.75, 9);
    expect(s.winRate).toBeCloseTo(2 / 3, 6);
  });

  it("期望 = 平均净收益；盈亏比 = 平均盈利 / |平均亏损|", () => {
    const s = summarize([tr(4), tr(2), tr(-1), tr(-3)]);
    expect(s.meanNet).toBeCloseTo(0.5, 9);
    expect(s.payoff).toBeCloseTo(3 / 2, 9);
  });

  it("没有亏损 → 盈亏比 null（不是无穷大，也不是 0）", () => {
    expect(summarize([tr(1), tr(2)]).payoff).toBeNull();
  });

  it("按离场原因与阶段拆分", () => {
    const s = summarize([tr(3, { exitReason: "目标", stage: "发酵" }), tr(-2, { exitReason: "止损", stage: "退潮" }), tr(1, { stage: "发酵" })]);
    expect(s.byExit).toMatchObject({ 目标: 1, 止损: 1, 期满: 1 });
    expect(s.byStage["发酵"]).toMatchObject({ n: 2, meanNet: 2 });
    expect(s.byStage["退潮"]).toMatchObject({ n: 1, meanNet: -2 });
  });

  it("空样本 → 各项 null，不报 NaN", () => {
    const s = summarize([]);
    expect(s.meanNet).toBeNull();
    expect(s.winRate).toBeNull();
    expect(s.maxDrawdown).toBeNull();
  });
});

describe("maxDrawdown（逐笔等权累加，按离场日排序）", () => {
  it("累计曲线 2, 5, 1, 3 → 回撤 4", () => {
    const ts = [tr(2, { exitDate: "2026-01-01" }), tr(3, { exitDate: "2026-01-02" }), tr(-4, { exitDate: "2026-01-03" }), tr(2, { exitDate: "2026-01-04" })];
    expect(maxDrawdown(ts)).toBeCloseTo(4, 9);
  });
  it("离场日乱序也按日期排", () => {
    const ts = [tr(-4, { exitDate: "2026-01-03" }), tr(2, { exitDate: "2026-01-01" }), tr(3, { exitDate: "2026-01-02" })];
    expect(maxDrawdown(ts)).toBeCloseTo(4, 9);
  });
  it("一路赚 → 0", () => {
    expect(maxDrawdown([tr(1), tr(2)])).toBe(0);
  });
});

describe("welch（两组均值差的 t）", () => {
  it("两组相同 → t = 0", () => {
    expect(welch([1, 2, 3], [1, 2, 3])!.t).toBeCloseTo(0, 9);
  });
  it("已知数值", () => {
    // a 均值 5 方差 2.5 (n=5)，b 均值 3 方差 2.5 (n=5)：se = sqrt(0.5+0.5)=1，t = 2
    const r = welch([3, 4, 5, 6, 7], [1, 2, 3, 4, 5])!;
    expect(r.diff).toBeCloseTo(2, 9);
    expect(r.t).toBeCloseTo(2, 9);
  });
  it("任一组少于 2 个 → null（算不出方差，不给一个假的 t）", () => {
    expect(welch([1], [1, 2, 3])).toBeNull();
  });
});

/**
 * 日度序列。毕业判定的两个 t 都改吃它（2026-09-27），因为同一天成交的几笔
 * 不是独立观测 —— 按笔算 t 会把"今天行情好"数成 N 份证据。
 */
describe("dailyReturns（按基准日合成的独立观测）", () => {
  it("同一天的几笔合成一个数，按日升序", () => {
    const ts = [
      tr(2, { baseDate: "2026-03-02" }), tr(4, { baseDate: "2026-03-02" }),
      tr(-1, { baseDate: "2026-03-01" }),
    ];
    expect(dailyReturns(ts)).toEqual([-1, 3]);
  });

  it("未触发的那天记 0，不是跳过 —— 挂单没成交就是这笔机会没兑现", () => {
    const ts = [
      tr(5, { baseDate: "2026-03-01" }),
      { ...tr(0), status: "未触发" as const, netPct: null, baseDate: "2026-03-02" },
      tr(1, { baseDate: "2026-03-03" }),
    ];
    expect(dailyReturns(ts)).toEqual([5, 0, 1]);
  });

  it("整天没成交的日子仍在序列里：那天资金闲置，收益就是 0", () => {
    const ts = [{ ...tr(0), status: "未触发" as const, netPct: null, baseDate: "2026-03-02" }];
    expect(dailyReturns(ts)).toEqual([0]);
  });

  /**
   * 2026-10-08 修正：有成交也有未触发的日子，之前只平均已结算的几笔，
   * 未触发的那几份被静悄悄跳过 —— 日度收益和 t 都被抬高。
   * 口径是"按预测数均分资金"，分母必须是当天全部预测。
   */
  it("同一天既有成交又有未触发：分母是当天全部预测数，未触发那份记 0", () => {
    const miss = { ...tr(0), status: "未触发" as const, netPct: null, baseDate: "2026-03-01" };
    const ts = [tr(6, { baseDate: "2026-03-01" }), tr(2, { baseDate: "2026-03-01" }), miss, miss];
    expect(dailyReturns(ts)).toEqual([2]);              // (6 + 2 + 0 + 0) / 4，不是 (6 + 2) / 2
  });

  it("还没落定的（netPct 为空 / 非已结算非未触发）既不进分子也不进分母", () => {
    const ts = [
      tr(4, { baseDate: "2026-03-01" }),
      { ...tr(0), status: "未触发" as const, netPct: null, baseDate: "2026-03-01" },
      tr(0, { baseDate: "2026-03-01", netPct: null }),
      { ...tr(0), status: "持有中" as any, netPct: null, baseDate: "2026-03-01" },
      { ...tr(0), status: "持有中" as any, netPct: null, baseDate: "2026-03-02" },
    ];
    expect(dailyReturns(ts)).toEqual([2]);              // 3/02 全是未落定：不出数
  });

  /**
   * 这条是改口径的全部理由，不能被别的断言替代。
   * 同样这批样本：逐笔看 60 笔、日度看 30 天，样本量差一倍，
   * 而逐笔的标准误比日度小得多 —— 因为同日的两笔完全正相关，
   * 逐笔把它们当成两条独立的证据了。t 值因此虚高一倍多。
   */
  it("同日相关让逐笔 t 虚高：同一批数据按笔算的 t 明显大于按天算", () => {
    const ts: Trade[] = [];
    for (let i = 0; i < 30; i++) {
      const d = `2026-03-${String(i + 1).padStart(2, "0")}`;
      const day = i % 2 === 0 ? 2 : -1;                 // 隔日好坏，日子之间有真差异
      ts.push(tr(day - 0.2, { baseDate: d }), tr(day + 0.2, { baseDate: d }));
    }
    const perTrade = ts.map(t => t.netPct as number);
    const perDay = dailyReturns(ts);
    expect(perTrade).toHaveLength(60);
    expect(perDay).toHaveLength(30);

    const tVs0 = (xs: number[]) => {
      const m = xs.reduce((s, x) => s + x, 0) / xs.length;
      const sd = Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1));
      return m / (sd / Math.sqrt(xs.length));
    };
    // 两边均值一样（都是 +0.5），样本量差一倍却得出不同的 t：
    // 逐笔把同日的两笔当成两条独立证据，标准误被 √2 压小，于是 t 大了约 40%
    expect(tVs0(perTrade)).toBeGreaterThan(2.4);
    expect(tVs0(perDay)).toBeLessThan(2.0);
    expect(tVs0(perTrade)).toBeGreaterThan(tVs0(perDay));
  });
});

describe("作废（决策晚于成交日 09:25）当它不存在", () => {
  const v = (over: Partial<Trade> = {}): Trade => ({ ...tr(0), status: "作废", netPct: null, exitDate: null, exitReason: null, ...over });

  it("summarize：不进触发率 / 胜率 / 期望 / 起止日，只单独报个数", () => {
    const base = [tr(2), tr(-1), { ...tr(0), status: "未触发" as const, netPct: null }];
    const s = summarize([...base, v({ baseDate: "2026-01-01" }), v()]);
    const { voided, ...rest } = s;
    expect(voided).toBe(2);
    const { voided: v0, ...clean } = summarize(base);
    expect(v0).toBe(0);
    expect(rest).toEqual(clean);
    expect(s.from).toBe("2026-08-25");
  });

  it("dailyReturns：不进分子也不进分母；整天作废的那天不出数", () => {
    expect(dailyReturns([tr(2), v(), { ...tr(0), status: "未触发", netPct: null }])).toEqual([1]);
    expect(dailyReturns([v({ baseDate: "2026-08-26" }), tr(2)])).toEqual([2]);
  });
});
