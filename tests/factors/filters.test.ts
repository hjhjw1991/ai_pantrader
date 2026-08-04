import { describe, it, expect } from "vitest";
import {
  runFilters, DEFAULT_FILTER_PARAMS, FILTER_NAMES, FILTER_FACTORS,
  UNSUPPORTED_FILTERS,
} from "@/lib/factors/filters";
import { makeView, seriesFrom, sealedBar, bar, sec, quote, weekdays } from "./view-double";
import type { DailyBar } from "@/lib/contracts";

const ds = weekdays("2026-06-01", 62);
const asOf = ds[61];

function viewFor(opts: {
  closes: number[]; board?: "主板" | "创业板" | "科创板" | "北交所";
  turnover?: number; amplitude?: number; noQuote?: boolean;
  lastBar?: Partial<DailyBar>; code?: string;
}) {
  const code = opts.code ?? "600000";
  const dates = ds.slice(ds.length - opts.closes.length);
  const bars = seriesFrom(code, dates, opts.closes);
  if (opts.lastBar) bars[bars.length - 1] = { ...bars[bars.length - 1], ...opts.lastBar };
  return makeView({
    asOf: dates[dates.length - 1],
    securities: [sec(code, opts.board ?? "主板")],
    bars: { [code]: bars },
    quotes: opts.noQuote ? {} : {
      [code]: quote(code, { turnover: opts.turnover ?? 5, amplitude: opts.amplitude ?? 4 }),
    },
  });
}

/** 21 根平稳日线：什么都不该被否 */
const calm = Array.from({ length: 40 }, (_, i) => 10 + (i % 3) * 0.05);

describe("过滤器 1 位置", () => {
  it("近 20 日涨幅 60% → 否决", () => {
    const closes = [...Array(20).fill(10), ...Array.from({ length: 20 }, (_, i) => 10 + i * 0.32)];
    const rep = runFilters(viewFor({ closes }), "600000", "贼王");
    const o = rep.outcomes.find(o => o.name === "位置")!;
    expect(o.pass).toBe(false);
    expect(o.evaluated).toBe(true);
    expect(o.reason).toMatch(/20日涨幅/);
    expect(rep.passedAll).toBe(false);
  });

  it("平稳 → 通过", () => {
    const rep = runFilters(viewFor({ closes: calm }), "600000", "贼王");
    expect(rep.outcomes.find(o => o.name === "位置")!.pass).toBe(true);
  });

  it("窗口内涨停次数超上限 → 否决（连续涨停偏离上龙虎榜那一条）", () => {
    // 20 根平盘 + 4 个主板涨停，累计涨幅仅 46% 不触发涨幅上限，但涨停次数触发
    const dates = ds.slice(ds.length - 25);
    const bars = seriesFrom("600000", dates.slice(0, 21), Array(21).fill(10));
    let c = 10;
    for (const d of dates.slice(21)) {
      bars.push(sealedBar("600000", d, c, 9.9));
      c = Math.round(c * 1.099 * 100) / 100;
    }
    const view = makeView({
      asOf: dates[dates.length - 1], securities: [sec("600000", "主板")],
      bars: { "600000": bars }, quotes: { "600000": quote("600000") },
    });
    const o = runFilters(view, "600000", "贼王", { 位置涨幅上限: 100 })
      .outcomes.find(o => o.name === "位置")!;
    expect(o.pass).toBe(false);
    expect(o.reason).toMatch(/涨停 4 次/);
  });

  it("创新高默认不否决（龙头回踩后再创新高是买点），可参数化打开", () => {
    const closes = [...Array(39).fill(10), 10.5];
    const view = viewFor({ closes });
    expect(runFilters(view, "600000", "贼王").outcomes.find(o => o.name === "位置")!.pass).toBe(true);
    const strict = runFilters(view, "600000", "贼王", { 新高即否决: true })
      .outcomes.find(o => o.name === "位置")!;
    expect(strict.pass).toBe(false);
    expect(strict.reason).toMatch(/新高/);
  });

  it("阈值可参数化", () => {
    const closes = [...Array(20).fill(10), ...Array.from({ length: 20 }, (_, i) => 10 + i * 0.1)];
    const strict = runFilters(viewFor({ closes }), "600000", "贼王", { 位置涨幅上限: 5 });
    expect(strict.outcomes.find(o => o.name === "位置")!.pass).toBe(false);
    const loose = runFilters(viewFor({ closes }), "600000", "贼王", { 位置涨幅上限: 50 });
    expect(loose.outcomes.find(o => o.name === "位置")!.pass).toBe(true);
  });
});

describe("过滤器 2 换手·振幅", () => {
  it("换手 22% → 否决", () => {
    const rep = runFilters(viewFor({ closes: calm, turnover: 22 }), "600000", "贼王");
    const o = rep.outcomes.find(o => o.name === "换手振幅")!;
    expect(o.pass).toBe(false);
    expect(o.reason).toMatch(/换手/);
  });

  it("日内振幅 12% → 否决", () => {
    const rep = runFilters(viewFor({ closes: calm, amplitude: 12 }), "600000", "贼王");
    expect(rep.outcomes.find(o => o.name === "换手振幅")!.pass).toBe(false);
  });

  it("没有快照 → 未判定，而不是放行", () => {
    const rep = runFilters(viewFor({ closes: calm, noQuote: true }), "600000", "贼王");
    const o = rep.outcomes.find(o => o.name === "换手振幅")!;
    expect(o.evaluated).toBe(false);
    expect(rep.unevaluated).toContain("换手振幅");
  });
});

describe("过滤器 3/4 缺数据源 —— 不许假装筛过了", () => {
  it("估值基本面 与 催化真伪 永远是未判定，并出现在 UNSUPPORTED_FILTERS 里", () => {
    const rep = runFilters(viewFor({ closes: calm }), "600000", "贼王");
    for (const name of ["估值基本面", "催化真伪"]) {
      const o = rep.outcomes.find(o => o.name === name)!;
      expect(o.evaluated).toBe(false);
      expect(o.reason).toMatch(/未采集|无数据源/);
      expect(rep.unevaluated).toContain(name);
    }
    expect(UNSUPPORTED_FILTERS.map(u => u.name)).toEqual(
      expect.arrayContaining(["估值基本面", "催化真伪"]));
  });

  it("未判定不计入 passedAll 的通过项", () => {
    const rep = runFilters(viewFor({ closes: calm }), "600000", "贼王");
    expect(rep.passedAll).toBe(true);            // 无硬否决
    expect(rep.passed).not.toContain("估值基本面");
  });
});

describe("过滤器 5 权限×账户", () => {
  // 账户名与其可交易板块全部由用户配置，测试自己给，不依赖代码里的任何预设账户
  const 权限 = { 账户可交易板块: { 主板only: ["主板"], 全开: ["主板", "创业板", "科创板"] } } as any;

  it("创业板 + 只开主板的账户 → 否决", () => {
    const rep = runFilters(
      viewFor({ closes: calm, board: "创业板", code: "300750" }), "300750", "主板only", 权限);
    const o = rep.outcomes.find(o => o.name === "权限账户")!;
    expect(o.pass).toBe(false);
    expect(o.evaluated).toBe(true);
    expect(o.reason).toMatch(/创业板/);
  });

  it("创业板 + 开了创业板的账户 → 通过", () => {
    const rep = runFilters(
      viewFor({ closes: calm, board: "创业板", code: "300750" }), "300750", "全开", 权限);
    expect(rep.outcomes.find(o => o.name === "权限账户")!.pass).toBe(true);
  });

  it("北交所不在任何账户的配置里 → 都否决", () => {
    for (const acct of ["主板only", "全开"]) {
      const rep = runFilters(
        viewFor({ closes: calm, board: "北交所", code: "832317" }), "832317", acct, 权限);
      expect(rep.outcomes.find(o => o.name === "权限账户")!.pass).toBe(false);
    }
  });

  it("账户未配置可交易板块 → 未判定，而不是否决一切", () => {
    // 空配置若当成"什么都不能买"，缺配置就会伪装成"策略很严格"
    const rep = runFilters(
      viewFor({ closes: calm, board: "主板", code: "600000" }), "600000", "没配过的账户", 权限);
    const o = rep.outcomes.find(o => o.name === "权限账户")!;
    expect(o.evaluated).toBe(false);
    expect(o.reason).toMatch(/未配置/);
  });

  it("不指定账户 → 这道筛未判定", () => {
    const rep = runFilters(viewFor({ closes: calm, board: "主板", code: "600000" }), "600000", null);
    expect(rep.outcomes.find(o => o.name === "权限账户")!.evaluated).toBe(false);
  });

  it("可交易板块可参数化", () => {
    const rep = runFilters(
      viewFor({ closes: calm, board: "创业板", code: "300750" }), "300750", "贼王",
      { 账户可交易板块: { 贼王: ["主板", "创业板"], 价值: ["主板", "创业板", "科创板"] } });
    expect(rep.outcomes.find(o => o.name === "权限账户")!.pass).toBe(true);
  });
});

describe("过滤器 6 打法匹配（用户不盯盘）", () => {
  it("近期平均振幅远大于止损幅度 → 否决（5% 止损在大振幅里秒破）", () => {
    const closes = Array.from({ length: 40 }, (_, i) => 10 + (i % 2 === 0 ? 0 : 1.5));
    const rep = runFilters(viewFor({ closes }), "600000", "贼王");
    const o = rep.outcomes.find(o => o.name === "打法匹配")!;
    expect(o.pass).toBe(false);
    expect(o.reason).toMatch(/振幅/);
  });

  it("平稳票通过", () => {
    expect(runFilters(viewFor({ closes: calm }), "600000", "贼王")
      .outcomes.find(o => o.name === "打法匹配")!.pass).toBe(true);
  });
});

describe("过滤器 7 目标匹配", () => {
  it("偏离 MA20 过大 → 否决追高（业绩/估值部分仍标未判定）", () => {
    const closes = [...Array(39).fill(10), 14];
    const rep = runFilters(viewFor({ closes }), "600000", "贼王");
    const o = rep.outcomes.find(o => o.name === "目标匹配")!;
    expect(o.pass).toBe(false);
    expect(o.partial).toBe(true);
    expect(o.reason).toMatch(/MA20/);
  });

  it("正常位置通过但仍标 partial", () => {
    const o = runFilters(viewFor({ closes: calm }), "600000", "贼王")
      .outcomes.find(o => o.name === "目标匹配")!;
    expect(o.pass).toBe(true);
    expect(o.partial).toBe(true);
  });
});

describe("过滤器整体", () => {
  it("七道筛一道不少", () => {
    expect(FILTER_NAMES).toHaveLength(7);
    const rep = runFilters(viewFor({ closes: calm }), "600000", "贼王");
    expect(rep.outcomes.map(o => o.name)).toEqual([...FILTER_NAMES]);
  });

  it("默认阈值与 spec §9.1 的 YAML 示例一致", () => {
    expect(DEFAULT_FILTER_PARAMS.位置涨幅上限).toBe(50);
    expect(DEFAULT_FILTER_PARAMS.换手上限).toBe(15);
    expect(DEFAULT_FILTER_PARAMS.振幅上限).toBe(10);
  });

  it("被剔除的要报出来是谁、为什么（不静默截断）", () => {
    const closes = [...Array(20).fill(10), ...Array.from({ length: 20 }, (_, i) => 10 + i * 0.32)];
    const rep = runFilters(viewFor({ closes, turnover: 30 }), "600000", "贼王");
    expect(rep.rejected).toContain("位置");
    expect(rep.rejected).toContain("换手振幅");
    for (const name of rep.rejected) {
      expect(rep.outcomes.find(o => o.name === name)!.reason).toBeTruthy();
    }
  });

  it("因子形态：置信度 = 已判定筛数 / 7", () => {
    const spec = FILTER_FACTORS.find(f => f.name === "过滤器")!;
    const view = viewFor({ closes: calm });
    const r = spec.fn({ view, params: {
      ...spec.defaults, code: "600000", 账户: "我的账户",
      账户可交易板块: { 我的账户: ["主板"] },
    } });
    expect(r.value).toBe(0);                       // 硬否决数
    expect(r.confidence).toBeCloseTo(5 / 7, 6);
    expect(r.provenance).toBe("real");
  });
});

it("bar 直接构造可用", () => {
  expect(bar("600000", asOf, 10).c).toBe(10);
});
