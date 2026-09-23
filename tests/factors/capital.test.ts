import { describe, it, expect } from "vitest";
import { CAPITAL_FACTORS } from "@/lib/factors/capital";
import type { FactorSpec, PointInTimeView } from "@/lib/contracts";
import { makeView, seriesFrom, sec, weekdays } from "./view-double";

function run<T>(name: string, view: PointInTimeView, params: Record<string, unknown> = {}) {
  const spec = CAPITAL_FACTORS.find(f => f.name === name) as FactorSpec<T> | undefined;
  if (!spec) throw new Error(`没有注册因子 ${name}`);
  return spec.fn({ view, params: { ...spec.defaults, code: "600000", ...params } });
}

const ASOF = "2026-09-23";
const base = {
  asOf: ASOF, securities: [sec("600000", "主板")],
  bars: { "600000": seriesFrom("600000", [ASOF], [10]) },
};
const mrow = (date: string, rzye: number | null, rzyezb: number | null = 0.02, rzjme: number | null = 0) =>
  ({ date, rzye, rzmre: null, rzjme, rzyezb });
const days6 = weekdays("2026-09-15", 6); // 09-15 … 09-22，都早于评估日

/* ------------------------------- 两融情绪 ------------------------------- */

describe("两融情绪（全市场融资余额的窗口变化率）", () => {
  const v = (rzyes: Array<number | null>, dates = days6) => makeView({
    ...base, marginMarket: rzyes.map((x, i) => mrow(dates[i], x, 0.026, 1e9)),
  });

  it("5 日融资余额 +2% → 加杠杆，值为变化率", () => {
    const r = run<number>("两融情绪", v([100, 100.5, 101, 101.2, 101.6, 102]));
    expect(r.value).toBeCloseTo(0.02, 9);
    expect(r.label).toBe("加杠杆");
    expect(r.confidence).toBe(1);
  });

  it("−2% → 去杠杆；±1% 以内 → 平稳", () => {
    expect(run<number>("两融情绪", v([100, 99, 99, 98.5, 98.2, 98])).label).toBe("去杠杆");
    expect(run<number>("两融情绪", v([100, 100, 100, 100, 100, 100.5])).label).toBe("平稳");
  });

  it("没有两融数据 → 置信 0，不给一个假的「平稳」", () => {
    const r = run<number>("两融情绪", makeView(base));
    expect(r.confidence).toBe(0);
    expect(r.label).toBe("无数据");
  });

  it("最新一条离评估日超过 10 天 → 数据过旧，置信 0", () => {
    const old = weekdays("2026-08-03", 6);
    const r = run<number>("两融情绪", v([100, 100, 100, 100, 100, 103], old));
    expect(r.confidence).toBe(0);
    expect(r.label).toBe("数据过旧");
  });

  it("窗口首值缺失 → 置信 0 而不是拿 0 当分母", () => {
    const r = run<number>("两融情绪", v([null, 100, 100, 100, 100, 101]));
    expect(r.confidence).toBe(0);
  });

  it("inputs 带上最新日期、余额、占流通、窗口净买入 —— 卡片上要看得出是哪天的数", () => {
    const r = run<any>("两融情绪", v([100, 100.5, 101, 101.2, 101.6, 102]));
    expect(r.inputs?.最新日期).toBe(days6[5]);
    expect(r.inputs?.融资余额).toBe(102);
    expect(r.inputs?.占流通).toBeCloseTo(0.026, 9);
    expect(r.inputs?.窗口净买入).toBeCloseTo(5e9, 0);
  });
});

/* ------------------------------- 个股融资 ------------------------------- */

describe("个股融资", () => {
  const market = days6.map(d => mrow(d, 1e12));
  const v = (rows: Array<{ date: string; rzye: number | null; rzyezb?: number | null }>, withMarket = true) =>
    makeView({
      ...base,
      marginMarket: withMarket ? market : [],
      marginStock: { "600000": rows.map(r => mrow(r.date, r.rzye, r.rzyezb ?? 0.03)) },
    });

  it("5 日融资余额 +20% → 融资涌入", () => {
    const r = run<number>("个股融资", v(days6.map((d, i) => ({ date: d, rzye: [100, 104, 108, 112, 116, 120][i] }))));
    expect(r.value).toBeCloseTo(0.2, 9);
    expect(r.label).toBe("融资涌入");
  });

  it("−20% → 融资撤离", () => {
    const r = run<number>("个股融资", v(days6.map((d, i) => ({ date: d, rzye: [100, 96, 92, 88, 84, 80][i] }))));
    expect(r.label).toBe("融资撤离");
  });

  it("融资余额占流通 ≥ 10% → 标签带「拥挤」—— 杠杆盘一松动就是踩踏", () => {
    const r = run<number>("个股融资", v(days6.map(d => ({ date: d, rzye: 100, rzyezb: 0.12 }))));
    expect(r.label).toBe("平稳·拥挤");
    expect(r.inputs?.拥挤).toBe(true);
  });

  it("汇总有数据而个股没有 → 非两融标的，置信 1（这是事实，不是缺数据）", () => {
    const r = run<number>("个股融资", v([]));
    expect(r.label).toBe("非两融标的");
    expect(r.confidence).toBe(1);
    expect(r.value).toBe(0);
  });

  it("个股最新日期落后于汇总 → 同样按非标的处理（已被调出标的名单）", () => {
    const r = run<number>("个股融资", v(days6.slice(0, 3).map(d => ({ date: d, rzye: 100 }))));
    expect(r.label).toBe("非两融标的");
  });

  it("连汇总都没有 → 置信 0：分不清是不是标的", () => {
    const r = run<number>("个股融资", v([], false));
    expect(r.confidence).toBe(0);
    expect(r.label).toBe("无数据");
  });
});

/* ------------------------------ 北向活跃度 ------------------------------ */

describe("北向活跃度（没有方向，只有成交额）", () => {
  const ds = weekdays("2026-08-20", 22);
  const v = (amts: number[], south: number | null = 5e9) => makeView({
    ...base,
    mutualDeal: amts.flatMap((a, i) => [
      { date: ds[i], mutualType: "005", dealAmt: a, netAmt: null },
      { date: ds[i], mutualType: "006", dealAmt: 1e11, netAmt: south },
    ]),
  });

  it("最新一天成交额 / 前 20 日均值 ≥ 1.3 → 北向放量", () => {
    const r = run<number>("北向活跃度", v([...Array(21).fill(2e11), 3e11]));
    expect(r.value).toBeCloseTo(1.5, 9);
    expect(r.label).toBe("北向放量");
  });

  it("≤ 0.7 → 北向缩量；之间 → 平常", () => {
    expect(run<number>("北向活跃度", v([...Array(21).fill(2e11), 1.2e11])).label).toBe("北向缩量");
    expect(run<number>("北向活跃度", v([...Array(21).fill(2e11), 2.1e11])).label).toBe("平常");
  });

  it("样本少于 5 天 → 置信 0", () => {
    const r = run<number>("北向活跃度", v([2e11, 2e11, 3e11]));
    expect(r.confidence).toBe(0);
  });

  it("南向净买额放进 inputs：A 股资金流向港股时它会放大", () => {
    const r = run<any>("北向活跃度", v([...Array(21).fill(2e11), 2e11], 8e9));
    expect(r.inputs?.南向净买).toBe(8e9);
  });

  it("北向净买额恒为 null 时 inputs 如实给 null，不写成 0", () => {
    const r = run<any>("北向活跃度", v([...Array(21).fill(2e11), 2e11]));
    expect(r.inputs?.北向净买).toBeNull();
  });
});

/* ------------------------------ 北向关注 ------------------------------ */

describe("北向关注（近 10 天上北向十大成交的天数）", () => {
  const deal = [{ date: "2026-09-22", mutualType: "005", dealAmt: 2e11, netAmt: null }];
  it("上榜天数即值", () => {
    const r = run<number>("北向关注", makeView({
      ...base, mutualDeal: deal,
      mutualTop10: { "600000": [
        { date: "2026-09-18", mutualType: "001", rank: 3, dealAmt: 1e9, mutualRatio: 0.1 },
        { date: "2026-09-22", mutualType: "001", rank: 1, dealAmt: 2e9, mutualRatio: 0.15 },
      ] },
    }));
    expect(r.value).toBe(2);
    expect(r.label).toBe("上榜");
  });

  it("没上榜 → 0，「未上榜」", () => {
    const r = run<number>("北向关注", makeView({ ...base, mutualDeal: deal }));
    expect(r.value).toBe(0);
    expect(r.label).toBe("未上榜");
    expect(r.confidence).toBe(1);
  });

  it("互联互通整体无数据 → 置信 0", () => {
    expect(run<number>("北向关注", makeView(base)).confidence).toBe(0);
  });
});

/* ----------------------------- 股东增减持 ----------------------------- */

describe("股东增减持（已实施，近 60 天公告）", () => {
  type Hc = { direction: "增持" | "减持"; changeFreeRatio: number | null };
  const v = (xs: Hc[]) => makeView({
    ...base,
    holderChanges: { "600000": xs.map((x, i) => ({
      holder: `股东${i}`, noticeDate: "2026-09-01", endDate: "2026-08-30", changeShares: null, ...x,
    })) },
  });

  it("无记录 → 0，「无」", () => {
    const r = run<number>("股东增减持", v([]));
    expect(r.value).toBe(0);
    expect(r.label).toBe("无");
    expect(r.confidence).toBe(1);
  });

  it("净额 = 带符号比例求和；≤ −2% → 大额净减持", () => {
    const r = run<number>("股东增减持", v([
      { direction: "减持", changeFreeRatio: -0.015 },
      { direction: "减持", changeFreeRatio: -0.01 },
      { direction: "增持", changeFreeRatio: 0.002 },
    ]));
    expect(r.value).toBeCloseTo(-0.023, 9);
    expect(r.label).toBe("大额净减持");
    expect(r.inputs?.减持笔数).toBe(2);
    expect(r.inputs?.增持笔数).toBe(1);
  });

  it("−0.5% 到 −2% → 净减持；≥ +0.5% → 净增持；之间 → 小额", () => {
    expect(run<number>("股东增减持", v([{ direction: "减持", changeFreeRatio: -0.008 }])).label).toBe("净减持");
    expect(run<number>("股东增减持", v([{ direction: "增持", changeFreeRatio: 0.01 }])).label).toBe("净增持");
    expect(run<number>("股东增减持", v([{ direction: "减持", changeFreeRatio: -0.001 }])).label).toBe("小额");
  });

  it("比例全部缺失 → 「比例未知」、置信 0，不叫「小额」", () => {
    const r = run<number>("股东增减持", v([{ direction: "增持", changeFreeRatio: null }]));
    expect(r.label).toBe("比例未知");
    expect(r.confidence).toBe(0);
  });

  it("比例缺失的笔数按比例打折置信度", () => {
    const r = run<number>("股东增减持", v([
      { direction: "减持", changeFreeRatio: null },
      { direction: "减持", changeFreeRatio: -0.01 },
    ]));
    expect(r.confidence).toBeCloseTo(0.5, 9);
  });
});
