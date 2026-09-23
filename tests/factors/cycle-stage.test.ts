/**
 * 五段状态机：冰点 / 启动 / 发酵 / 高潮 / 退潮。
 *
 * 名字人定，阈值数据学：热度本身是分位（相对自己 250 日历史），
 * "明显变化"的幅度 δ 取热度日变化的标准差。
 */
import { describe, it, expect } from "vitest";
import { runStages, CYCLE_FACTORS } from "@/lib/factors/cycle";
import type { SentimentRow } from "@/lib/contracts";
import { makeView, weekdays } from "./view-double";

const O = { hi: 0.8, lo: 0.2, mid: 0.5, delta: 0.1, lookback: 3 };

describe("runStages（纯状态机）", () => {
  it("高于 hi → 高潮；低于 lo → 冰点，无论从哪来", () => {
    expect(runStages([0.5, 0.5, 0.5, 0.9], O).at(-1)).toBe("高潮");
    expect(runStages([0.5, 0.5, 0.5, 0.1], O).at(-1)).toBe("冰点");
  });

  it("冰点之后明显回升 → 启动；继续升过 mid → 发酵", () => {
    const s = runStages([0.1, 0.1, 0.1, 0.15, 0.3, 0.45, 0.55, 0.6], O);
    expect(s).toEqual(["冰点", "冰点", "冰点", "冰点", "启动", "启动", "发酵", "发酵"]);
  });

  it("高潮回落出 hi → 退潮；一路跌到 lo 以下 → 冰点", () => {
    const s = runStages([0.9, 0.9, 0.9, 0.7, 0.5, 0.3, 0.15], O);
    expect(s.slice(3)).toEqual(["退潮", "退潮", "退潮", "冰点"]);
  });

  it("发酵中明显回落 → 退潮", () => {
    const s = runStages([0.1, 0.1, 0.1, 0.3, 0.55, 0.6, 0.62, 0.45, 0.35], O);
    expect(s.at(-1)).toBe("退潮");
  });

  it("信号不明（中位区间、变化小于 δ）→ 维持上一个阶段：不来回跳", () => {
    const s = runStages([0.1, 0.1, 0.1, 0.3, 0.55, 0.56, 0.54, 0.55, 0.53], O);
    expect(new Set(s.slice(4))).toEqual(new Set(["发酵"]));
  });

  it("退潮后明显反弹 → 启动（新一轮）", () => {
    const s = runStages([0.9, 0.9, 0.9, 0.6, 0.4, 0.3, 0.45, 0.5], O);
    expect(s.at(-1)).toBe("启动");
  });

  it("滞回：进高潮要 ≥ hi，出高潮要跌破 hi − band —— 贴着线抖动不算切换", () => {
    const b = { ...O, band: 0.1 };
    expect(runStages([0.5, 0.5, 0.5, 0.85, 0.75, 0.78], b).slice(3)).toEqual(["高潮", "高潮", "高潮"]);
    expect(runStages([0.5, 0.5, 0.5, 0.85, 0.65], b).at(-1)).toBe("退潮");
  });

  it("滞回对冰点同理：出冰点要升过 lo + band 且明显回升", () => {
    const b = { ...O, band: 0.1 };
    expect(runStages([0.5, 0.5, 0.5, 0.15, 0.25, 0.28], b).slice(3)).toEqual(["冰点", "冰点", "冰点"]);
  });

  it("null（那天分项不足）沿用上一个阶段", () => {
    expect(runStages([0.1, 0.1, null, 0.1], O)).toEqual(["冰点", "冰点", "冰点", "冰点"]);
  });
});

/* ------------------------------ 情绪阶段因子 ------------------------------ */

const blank = (date: string, k: number): SentimentRow => ({
  date, up: 2000, down: 2000, flat: 100, unknown: 50,
  medianPct: k, avgPct: k, zt: 60, dt: 5, zb: 20, zbRate: 0.5 - k / 20,
  maxLbc: 4, lbCount: 10, firstPrev: 50, firstPromo: 0.2 + k / 50,
  multiPrev: 10, multiPromo: 0.4 + k / 50, ztPrem: k, ztOpenPrem: k / 2,
  firstPrem: k, multiPrem: k, zbPrem: k, highLbcPrev: 4, highPrem: k,
});

/** 700 天：前面在 −1..+1 之间随机游走（确定性），最后 20 天由参数给出的走势 */
function rows(tail: number[]): SentimentRow[] {
  const ds = weekdays("2023-06-01", 700);
  const n = ds.length - tail.length;
  return ds.map((d, i) => blank(d, i < n ? Math.sin(i / 7) + Math.sin(i / 17) * 0.5 : tail[i - n]));
}
const run = (rs: SentimentRow[], params: Record<string, unknown> = {}) => {
  const f = CYCLE_FACTORS.find(x => x.name === "情绪阶段")!;
  return f.fn({ view: makeView({ asOf: rs[rs.length - 1].date, sentiment: rs }), params: { ...f.defaults, ...params } }) as any;
};

describe("情绪阶段因子", () => {
  it("全面走冷到历史低位 → 冰点；全面极热 → 高潮", () => {
    expect(run(rows(Array(20).fill(-3))).label).toBe("冰点");
    expect(run(rows(Array(20).fill(3))).label).toBe("高潮");
  });

  it("值是热度分位（0~1），inputs 带分项分位、δ、近 10 日阶段轨迹", () => {
    const r = run(rows(Array(20).fill(3)));
    expect(r.value).toBeGreaterThan(0.8);
    expect(r.inputs.分项分位).toHaveProperty("首板晋级率");
    expect(r.inputs.δ).toBeGreaterThan(0);
    expect(r.inputs.轨迹).toHaveLength(10);
    expect(r.provenance).toBe("proxy");
  });

  it("从冷点拉起、升到中高位 → 启动或发酵，不会是冰点或退潮", () => {
    // 历史在 ±1.5 之间摆动；从 −3（极冷）拉回到 0.3 附近（中位偏上）
    const tail = [...Array(10).fill(-3), -2, -1, -0.5, 0, 0.2, 0.3, 0.3, 0.4, 0.4, 0.5];
    expect(["启动", "发酵"]).toContain(run(rows(tail)).label);
  });

  it("极热之后快速降温 → 退潮", () => {
    // 极热 12 天后回到中位区间：高潮之后的中位不是发酵，是退潮
    const tail = [...Array(12).fill(3), 2, 1, 0.5, 0.2, 0, 0, 0.1, 0];
    expect(run(rows(tail)).label).toBe("退潮");
  });

  it("评估日没有派生行 → 未构建，置信 0", () => {
    const rs = rows(Array(20).fill(0));
    const f = CYCLE_FACTORS.find(x => x.name === "情绪阶段")!;
    const v = makeView({ asOf: "2031-01-01", sentiment: rs });
    const r = f.fn({ view: v, params: { ...f.defaults } });
    expect(r.label).toBe("未构建");
    expect(r.confidence).toBe(0);
  });

  it("历史太短（算不出 250 日分位的分位）→ 样本不足，置信 0，不猜阶段", () => {
    const rs = rows(Array(20).fill(3)).slice(-200);
    const r = run(rs);
    expect(r.label).toBe("样本不足");
    expect(r.confidence).toBe(0);
  });
});
