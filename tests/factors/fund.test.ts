import { describe, it, expect } from "vitest";
import {
  FUND_FACTORS, aggregateLhbByCode, dedupeSeats, classifySeat,
} from "@/lib/factors/fund";
import type { FactorSpec, PointInTimeView } from "@/lib/contracts";
import { makeView, lhbRow, seatRow, ztRow, sec, bar } from "./view-double";

function run<T>(name: string, view: PointInTimeView, params: Record<string, unknown> = {}) {
  const spec = FUND_FACTORS.find(f => f.name === name) as FactorSpec<T> | undefined;
  if (!spec) throw new Error(`没有注册因子 ${name}`);
  return spec.fn({ view, params: { ...spec.defaults, ...params } });
}

const D = "2026-08-03";

describe("aggregateLhbByCode —— 同票同日多行不许按 code 去重，也不许无脑相加", () => {
  // 利欧股份 2026-08-03 实测三条上榜原因
  const rows = [
    lhbRow(D, "002131", "1", 5.0e7, { explanation: "日换手率达到20%的前5只证券" }),
    lhbRow(D, "002131", "2", 3.0e7, { explanation: "日涨幅偏离值达到7%的前5只证券" }),
    lhbRow(D, "002131", "3", 4.5e7, { explanation: "连续三个交易日内，涨幅偏离值累计达到20%的证券" }),
    lhbRow(D, "600000", "1", -2.0e7),
  ];

  it("三行合成一只票，但净买额取绝对值最大的一行，不是三行之和", () => {
    const agg = aggregateLhbByCode(rows);
    const a = agg.get("002131")!;
    expect(a.netAmt).toBe(5.0e7);
    expect(a.netAmt).not.toBe(1.25e8);      // 相加 = 把同一笔钱按上榜原因个数重复计
    expect(a.rowCount).toBe(3);
    expect(a.reasons).toHaveLength(3);
    expect(agg.size).toBe(2);
  });

  it("多个上榜原因本身是异动强度信号，要留下来", () => {
    expect(aggregateLhbByCode(rows).get("600000")!.rowCount).toBe(1);
  });

  it("显式要求求和时才求和（默认不用）", () => {
    expect(aggregateLhbByCode(rows, "sum").get("002131")!.netAmt).toBe(1.25e8);
  });
});

describe("d1_chg 空值处理 —— 上榜当日全 null，随时间回填", () => {
  it("全为 null → value null、confidence 0", () => {
    const view = makeView({
      asOf: D, tradingDays: ["2026-07-31", D],
      lhb: { "2026-07-31": [lhbRow("2026-07-31", "002131", "1", 5e7), lhbRow("2026-07-31", "600000", "1", 2e7)] },
    });
    const r = run<number | null>("龙虎榜次日兑现", view, { 日期: "2026-07-31" });
    expect(r.value).toBeNull();
    expect(r.confidence).toBe(0);
  });

  it("只对非 null 行求均值，不把 null 当 0", () => {
    const view = makeView({
      asOf: D, tradingDays: ["2026-07-31", D],
      lhb: {
        "2026-07-31": [
          lhbRow("2026-07-31", "002131", "1", 5e7, { d1Chg: 6 }),
          lhbRow("2026-07-31", "600000", "1", 2e7, { d1Chg: 2 }),
          lhbRow("2026-07-31", "600001", "1", 1e7, { d1Chg: null }),
        ],
      },
    });
    const r = run<number | null>("龙虎榜次日兑现", view, { 日期: "2026-07-31" });
    expect(r.value).toBeCloseTo(4, 6);          // (6+2)/2，不是 (6+2+0)/3
    expect(r.inputs?.["有效样本"]).toBe(2);
    expect(r.inputs?.["缺标签样本"]).toBe(1);
    expect(r.confidence).toBeLessThan(1);
  });
});

describe("席位分类与去重", () => {
  it("机构专用 / 沪深股通专用 不是游资", () => {
    expect(classifySeat("机构专用")).toBe("机构");
    expect(classifySeat("深股通专用")).toBe("北向");
    expect(classifySeat("沪股通专用")).toBe("北向");
    expect(classifySeat("华鑫证券有限责任公司上海分公司")).toBe("营业部");
  });

  it("同一席位跨多个上榜原因重复出现 → 取净额绝对值最大的一条，不相加", () => {
    const seats = [
      seatRow(D, "002131", "华鑫证券上海分公司", 3e7, { changeType: "1" }),
      seatRow(D, "002131", "华鑫证券上海分公司", 2e7, { changeType: "2" }),
      seatRow(D, "002131", "机构专用", 1e7, { changeType: "1" }),
    ];
    const out = dedupeSeats(seats);
    expect(out).toHaveLength(2);
    expect(out.find(s => s.deptName === "华鑫证券上海分公司")!.netAmt).toBe(3e7);
  });
});

describe("游资席位识别", () => {
  const seats = [
    seatRow(D, "002131", "华鑫证券有限责任公司上海分公司", 4e7, { riseProb3d: 62, buyerTimes3d: 8 }),
    seatRow(D, "002131", "东方财富证券拉萨东环路第二营业部", 1e7, { riseProb3d: 30 }),
    seatRow(D, "002131", "机构专用", 6e7, { riseProb3d: null }),
    seatRow(D, "002131", "深股通专用", 2e7, { riseProb3d: null }),
    seatRow(D, "002131", "某营业部胜率未知", 5e6, { riseProb3d: null }),
  ];
  const view = makeView({ asOf: D, seats: { [D]: seats } });

  it("只把胜率达标的营业部算成游资；机构与北向单列", () => {
    const r = run<number>("游资席位识别", view, { code: "002131" });
    expect(r.value).toBe(4e7);
    expect(r.inputs?.["机构净买"]).toBe(6e7);
    expect(r.inputs?.["北向净买"]).toBe(2e7);
    expect(r.inputs?.["游资席位"]).toEqual(["华鑫证券有限责任公司上海分公司"]);
    expect(r.label).toBe("机构主导");
  });

  it("胜率为 null 的营业部计入'未知'并压低置信度", () => {
    const r = run<number>("游资席位识别", view, { code: "002131" });
    expect(r.inputs?.["胜率缺失席位数"]).toBe(1);
    expect(r.confidence).toBeLessThan(0.9);
  });

  it("没有席位数据 → 置信 0", () => {
    const r = run<number>("游资席位识别", makeView({ asOf: D }), { code: "002131" });
    expect(r.confidence).toBe(0);
  });
});

describe("龙虎榜净买 / 净买聚类", () => {
  const rows = [
    lhbRow(D, "002131", "1", 5e7), lhbRow(D, "002131", "2", 3e7),
    lhbRow(D, "300750", "1", 8e7),
    lhbRow(D, "600000", "1", -6e7),
    lhbRow(D, "600519", "1", -1e6),
  ];
  const view = makeView({ asOf: D, lhb: { [D]: rows } });

  it("单票净买（多行取代表行）", () => {
    expect(run<number | null>("龙虎榜净买", view, { code: "002131" }).value).toBe(5e7);
  });

  it("榜上无名 → null 而不是 0", () => {
    const r = run<number | null>("龙虎榜净买", view, { code: "000001" });
    expect(r.value).toBeNull();
  });

  it("净买聚类分簇", () => {
    const r = run<number>("龙虎榜净买聚类", view);
    expect(r.inputs?.["大额净买"]).toBe(2);     // 002131 5e7 / 300750 8e7
    expect(r.inputs?.["大额净卖"]).toBe(1);     // 600000 -6e7
    expect(r.inputs?.["净卖"]).toBe(1);         // 600519 -1e6
    expect(r.inputs?.["上榜票数"]).toBe(4);
    expect(r.value).toBeGreaterThan(50);
  });

  it("当日无龙虎榜数据 → null + 置信 0（交易日必然有榜，空 = 缺数据）", () => {
    const r = run<number | null>("龙虎榜净买聚类", makeView({ asOf: D }));
    expect(r.value).toBeNull();
    expect(r.confidence).toBe(0);
  });
});

describe("板块净流入", () => {
  const view = makeView({
    asOf: D,
    securities: [sec("002131", "主板"), sec("300750", "创业板"), sec("600000", "主板")],
    bars: { "002131": [bar("002131", D, 10)] },
    zt: {
      [D]: [
        ztRow(D, "002131", { sector: "半导体" }),
        ztRow(D, "300750", { sector: "半导体" }),
        ztRow(D, "600000", { sector: "银行" }),
      ],
    },
    lhb: {
      [D]: [
        lhbRow(D, "002131", "1", 5e7), lhbRow(D, "002131", "2", 3e7),
        lhbRow(D, "300750", "1", 8e7),
        lhbRow(D, "600000", "1", -6e7),
        lhbRow(D, "999999", "1", 1e7),      // 无板块映射，计入未覆盖
      ],
    },
  });

  it("指定板块 → 该板块净流入（同票多行不重复计）", () => {
    const r = run<number | null>("板块净流入", view, { 板块: "半导体" });
    expect(r.value).toBe(1.3e8);            // 5e7 + 8e7
  });

  it("不指定板块 → 返回净流入最强的板块", () => {
    const r = run<number | null>("板块净流入", view);
    expect(r.label).toBe("半导体");
    expect(r.value).toBe(1.3e8);
  });

  it("板块映射只覆盖涨停池成员 → 覆盖率写进 inputs 并压低置信", () => {
    const r = run<number | null>("板块净流入", view, { 板块: "半导体" });
    expect(r.inputs?.["板块映射覆盖率"]).toBeCloseTo(3 / 4, 6);
    expect(r.confidence).toBeLessThan(1);
  });

  it("无涨停池 → 没有板块映射 → 置信 0", () => {
    const v = makeView({ asOf: D, lhb: { [D]: [lhbRow(D, "002131", "1", 5e7)] } });
    expect(run<number | null>("板块净流入", v, { 板块: "半导体" }).confidence).toBe(0);
  });
});
