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
  /** 被测票的 PE；给了就造一份 12 只同行（PE 10..120）的估值横截面 */
  pe?: number;
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
    ...(opts.pe === undefined ? {} : {
      valuationCs: {
        date: dates[dates.length - 1],
        rows: [
          { code, pe: opts.pe, pb: null, mktcap: null },
          ...Array.from({ length: 12 }, (_, i) => ({ code: `3000${String(i).padStart(2, "0")}`, pe: 10 + i * 10, pb: null, mktcap: null })),
        ],
      },
      industries1: [code, ...Array.from({ length: 12 }, (_, i) => `3000${String(i).padStart(2, "0")}`)]
        .map(c => ({ code: c, indexCode: "801080", indexName: "半导体" })),
    }),
  });
}

/** 21 根平稳日线：什么都不该被否 */
const calm = Array.from({ length: 40 }, (_, i) => 10 + (i % 3) * 0.05);

describe("过滤器 1 位置", () => {
  it("近 20 日涨幅 60% → 否决", () => {
    const closes = [...Array(20).fill(10), ...Array.from({ length: 20 }, (_, i) => 10 + i * 0.32)];
    const rep = runFilters(viewFor({ closes }), "600000", "卫星");
    const o = rep.outcomes.find(o => o.name === "位置")!;
    expect(o.pass).toBe(false);
    expect(o.evaluated).toBe(true);
    expect(o.reason).toMatch(/20日涨幅/);
    expect(rep.passedAll).toBe(false);
  });

  it("平稳 → 通过", () => {
    const rep = runFilters(viewFor({ closes: calm }), "600000", "卫星");
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
    const o = runFilters(view, "600000", "卫星", { 位置涨幅上限: 100 })
      .outcomes.find(o => o.name === "位置")!;
    expect(o.pass).toBe(false);
    expect(o.reason).toMatch(/涨停 4 次/);
  });

  it("创新高默认不否决（龙头回踩后再创新高是买点），可参数化打开", () => {
    const closes = [...Array(39).fill(10), 10.5];
    const view = viewFor({ closes });
    expect(runFilters(view, "600000", "卫星").outcomes.find(o => o.name === "位置")!.pass).toBe(true);
    const strict = runFilters(view, "600000", "卫星", { 新高即否决: true })
      .outcomes.find(o => o.name === "位置")!;
    expect(strict.pass).toBe(false);
    expect(strict.reason).toMatch(/新高/);
  });

  it("阈值可参数化", () => {
    const closes = [...Array(20).fill(10), ...Array.from({ length: 20 }, (_, i) => 10 + i * 0.1)];
    const strict = runFilters(viewFor({ closes }), "600000", "卫星", { 位置涨幅上限: 5 });
    expect(strict.outcomes.find(o => o.name === "位置")!.pass).toBe(false);
    const loose = runFilters(viewFor({ closes }), "600000", "卫星", { 位置涨幅上限: 50 });
    expect(loose.outcomes.find(o => o.name === "位置")!.pass).toBe(true);
  });
});

describe("过滤器 2 换手·振幅", () => {
  it("换手 22% → 否决", () => {
    const rep = runFilters(viewFor({ closes: calm, turnover: 22 }), "600000", "卫星");
    const o = rep.outcomes.find(o => o.name === "换手振幅")!;
    expect(o.pass).toBe(false);
    expect(o.reason).toMatch(/换手/);
  });

  it("日内振幅 12% → 否决", () => {
    const rep = runFilters(viewFor({ closes: calm, amplitude: 12 }), "600000", "卫星");
    expect(rep.outcomes.find(o => o.name === "换手振幅")!.pass).toBe(false);
  });

  it("没有快照 → 未判定，而不是放行", () => {
    const rep = runFilters(viewFor({ closes: calm, noQuote: true }), "600000", "卫星");
    const o = rep.outcomes.find(o => o.name === "换手振幅")!;
    expect(o.evaluated).toBe(false);
    expect(rep.unevaluated).toContain("换手振幅");
  });
});

describe("过滤器 3/4 缺数据源 —— 不许假装筛过了", () => {
  it("催化真伪永远是未判定，并出现在 UNSUPPORTED_FILTERS 里", () => {
    const rep = runFilters(viewFor({ closes: calm }), "600000", "卫星");
    const o = rep.outcomes.find(o => o.name === "催化真伪")!;
    expect(o.evaluated).toBe(false);
    expect(o.reason).toMatch(/未采集|无数据源/);
    expect(rep.unevaluated).toContain("催化真伪");
    expect(UNSUPPORTED_FILTERS.map(u => u.name)).toEqual(["催化真伪"]);
  });

  it("估值基本面没有估值快照时是未判定（partial），而不是通过", () => {
    const rep = runFilters(viewFor({ closes: calm }), "600000", "卫星");
    const o = rep.outcomes.find(o => o.name === "估值基本面")!;
    expect(o.evaluated).toBe(false);
    expect(o.partial).toBe(true);
    expect(o.reason).toMatch(/无估值数据/);
    expect(rep.unevaluated).toContain("估值基本面");
  });
});

describe("过滤器 3 估值基本面（行业内 PE 分位，业绩半边缺）", () => {
  it("行业内最贵的 5% → 否决，理由里写出分位与同行倍数", () => {
    const rep = runFilters(viewFor({ closes: calm, pe: 500 }), "600000", "卫星");
    const o = rep.outcomes.find(o => o.name === "估值基本面")!;
    expect(o.pass).toBe(false);
    expect(o.evaluated).toBe(true);
    expect(o.partial).toBe(true);
    expect(o.reason).toMatch(/半导体内第 100 百分位/);
    expect(o.reason).toMatch(/同行中位的 7\.7 倍/);
    expect(o.reason).toMatch(/且 ≥ 2 倍，否决/);
    expect(rep.passedAll).toBe(false);
  });

  it("行业中游 → 通过（仍标 partial：业绩部分没判）", () => {
    const o = runFilters(viewFor({ closes: calm, pe: 60 }), "600000", "卫星").outcomes.find(o => o.name === "估值基本面")!;
    expect(o.pass).toBe(true);
    expect(o.partial).toBe(true);
    expect(o.reason).toMatch(/业绩部分未判定/);
  });

  it("亏损默认不否决；亏损即否决 = true 时否决", () => {
    const loose = runFilters(viewFor({ closes: calm, pe: -20 }), "600000", "卫星").outcomes.find(o => o.name === "估值基本面")!;
    expect(loose.pass).toBe(true);
    expect(loose.reason).toMatch(/亏损/);
    const strict = runFilters(viewFor({ closes: calm, pe: -20 }), "600000", "卫星", { 亏损即否决: true })
      .outcomes.find(o => o.name === "估值基本面")!;
    expect(strict.pass).toBe(false);
  });

  it("分位高但只比同行贵一点（< 2 倍）→ 不否决：那是龙头溢价，不是畸高（工行在银行业排 0.95 分位）", () => {
    // 同行 PE 10..120，中位 65；PE 125 排第一，但只是中位的 1.9 倍
    const o = runFilters(viewFor({ closes: calm, pe: 125 }), "600000", "卫星").outcomes.find(o => o.name === "估值基本面")!;
    expect(o.reason).toMatch(/第 100 百分位/);
    expect(o.pass).toBe(true);
  });

  it("估值否决分位 = 1.01 等于关掉", () => {
    const o = runFilters(viewFor({ closes: calm, pe: 500 }), "600000", "卫星", { 估值否决分位: 1.01 })
      .outcomes.find(o => o.name === "估值基本面")!;
    expect(o.pass).toBe(true);
  });

  it("未判定不计入 passedAll 的通过项", () => {
    const rep = runFilters(viewFor({ closes: calm }), "600000", "卫星");
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
      viewFor({ closes: calm, board: "创业板", code: "300750" }), "300750", "卫星",
      { 账户可交易板块: { 卫星: ["主板", "创业板"], 核心: ["主板", "创业板", "科创板"] } });
    expect(rep.outcomes.find(o => o.name === "权限账户")!.pass).toBe(true);
  });
});

describe("过滤器 6 打法匹配（用户不盯盘）", () => {
  it("近期平均振幅远大于止损幅度 → 否决（5% 止损在大振幅里秒破）", () => {
    const closes = Array.from({ length: 40 }, (_, i) => 10 + (i % 2 === 0 ? 0 : 1.5));
    const rep = runFilters(viewFor({ closes }), "600000", "卫星");
    const o = rep.outcomes.find(o => o.name === "打法匹配")!;
    expect(o.pass).toBe(false);
    expect(o.reason).toMatch(/振幅/);
  });

  it("平稳票通过", () => {
    expect(runFilters(viewFor({ closes: calm }), "600000", "卫星")
      .outcomes.find(o => o.name === "打法匹配")!.pass).toBe(true);
  });
});

describe("过滤器 7 目标匹配", () => {
  it("偏离 MA20 过大 → 否决追高（业绩/估值部分仍标未判定）", () => {
    const closes = [...Array(39).fill(10), 14];
    const rep = runFilters(viewFor({ closes }), "600000", "卫星");
    const o = rep.outcomes.find(o => o.name === "目标匹配")!;
    expect(o.pass).toBe(false);
    expect(o.partial).toBe(true);
    expect(o.reason).toMatch(/MA20/);
  });

  it("正常位置通过但仍标 partial", () => {
    const o = runFilters(viewFor({ closes: calm }), "600000", "卫星")
      .outcomes.find(o => o.name === "目标匹配")!;
    expect(o.pass).toBe(true);
    expect(o.partial).toBe(true);
  });
});

describe("过滤器整体", () => {
  it("十道筛一道不少 —— 在原七道之上加了 ST / 解禁减持 / 超买三道风险否决", () => {
    expect(FILTER_NAMES).toHaveLength(10);
    const rep = runFilters(viewFor({ closes: calm }), "600000", "卫星");
    expect(rep.outcomes.map(o => o.name)).toEqual([...FILTER_NAMES]);
  });

  it("默认阈值与 spec §9.1 的 YAML 示例一致", () => {
    expect(DEFAULT_FILTER_PARAMS.位置涨幅上限).toBe(50);
    expect(DEFAULT_FILTER_PARAMS.换手上限).toBe(15);
    expect(DEFAULT_FILTER_PARAMS.振幅上限).toBe(10);
  });

  it("被剔除的要报出来是谁、为什么（不静默截断）", () => {
    const closes = [...Array(20).fill(10), ...Array.from({ length: 20 }, (_, i) => 10 + i * 0.32)];
    const rep = runFilters(viewFor({ closes, turnover: 30 }), "600000", "卫星");
    expect(rep.rejected).toContain("位置");
    expect(rep.rejected).toContain("换手振幅");
    for (const name of rep.rejected) {
      expect(rep.outcomes.find(o => o.name === name)!.reason).toBeTruthy();
    }
  });

  it("因子形态：置信度 = 已判定筛数 / 筛总数", () => {
    const spec = FILTER_FACTORS.find(f => f.name === "过滤器")!;
    const view = viewFor({ closes: calm });
    const r = spec.fn({ view, params: {
      ...spec.defaults, code: "600000", 账户: "我的账户",
      账户可交易板块: { 我的账户: ["主板"] },
    } });
    expect(r.value).toBe(0);                       // 硬否决数
    // 原 5 道 + ST + 超买 + 解禁减持（减持部分在观测起点前未观测，但解禁那半能判，按 partial 计入）
    // 估值基本面、催化真伪仍无数据源
    expect(r.confidence).toBeCloseTo(8 / 10, 6);
    expect(r.provenance).toBe("real");
  });
});

it("bar 直接构造可用", () => {
  expect(bar("600000", asOf, 10).c).toBe(10);
});

/* ---------------------------- 风险否决三道 ---------------------------- */

describe("过滤器 8 ST", () => {
  const stView = (hist: Array<{ from: string; to: string | null }>) => {
    const dates = ds.slice(ds.length - 40);
    return makeView({
      asOf: dates[dates.length - 1],
      securities: [sec("600000", "主板", { name: "*ST测试", isStHistory: hist })],
      bars: { "600000": seriesFrom("600000", dates, calm) },
      quotes: { "600000": quote("600000", { turnover: 5, amplitude: 4 }) },
    });
  };

  it("戴帽 → 否决", () => {
    const rep = runFilters(stView([{ from: "2026-01-01", to: null }]), "600000", "卫星");
    const o = rep.outcomes.find(o => o.name === "ST")!;
    expect(o.evaluated).toBe(true);
    expect(o.pass).toBe(false);
    expect(rep.rejected).toContain("ST");
  });

  it("未戴帽 → 通过", () => {
    const o = runFilters(stView([]), "600000", "卫星").outcomes.find(o => o.name === "ST")!;
    expect(o.evaluated).toBe(true);
    expect(o.pass).toBe(true);
  });

  it("观测起点之前 → **未判定**，不是通过", () => {
    const o = runFilters(stView([]), "600000", "卫星", { ST观测起点: "2099-01-01" } as any)
      .outcomes.find(o => o.name === "ST")!;
    expect(o.evaluated).toBe(false);
  });
});

describe("过滤器 9 解禁减持", () => {
  const riskView = (opt: { lift?: number; plan?: number }) => {
    const dates = ds.slice(ds.length - 40);
    const asOfD = dates[dates.length - 1];
    return makeView({
      asOf: asOfD,
      securities: [sec("600000", "主板")],
      bars: { "600000": seriesFrom("600000", dates, calm) },
      quotes: { "600000": quote("600000", { turnover: 5, amplitude: 4 }) },
      lifts: opt.lift === undefined ? {} : { "600000": [{ date: asOfD, freeRatio: opt.lift, liftMktcap: 1e8, shareType: "首发" }] },
      plans: opt.plan === undefined ? {} : { "600000": [{
        actor: "股东甲", startDate: asOfD, endDate: "2099-01-01", maxRatio: opt.plan, maxShares: 1e7, firstSeen: "2000-01-01",
      }] },
    });
  };
  const o = (v: any, extra: Record<string, unknown> = {}) =>
    runFilters(v, "600000", "卫星", { 减持观测起点: "2000-01-01", ...extra } as any).outcomes.find(x => x.name === "解禁减持")!;

  it("没有解禁、没有减持计划 → 通过", () => {
    expect(o(riskView({}))).toMatchObject({ evaluated: true, pass: true });
  });

  it("解禁占流通 ≥ 否决线（默认 15%）→ 否决", () => {
    expect(o(riskView({ lift: 0.2 })).pass).toBe(false);
  });

  it("解禁在预警区（5%~15%）→ 通过但说明里点名 —— 买点的赔率会被压，人要知道", () => {
    const r = o(riskView({ lift: 0.08 }));
    expect(r.pass).toBe(true);
    expect(r.reason).toMatch(/解禁/);
  });

  it("减持计划上限 ≥ 否决线（默认 3% 总股本）→ 否决", () => {
    expect(o(riskView({ plan: 0.03 })).pass).toBe(false);
  });

  it("**减持计划未观测时按 partial 计** —— 解禁那半能判，不能因为另一半缺数据整道筛失明", () => {
    const r = runFilters(riskView({}), "600000", "卫星", { 减持观测起点: "2099-01-01" } as any)
      .outcomes.find(x => x.name === "解禁减持")!;
    expect(r.evaluated).toBe(true);
    expect(r.partial).toBe(true);
    expect(r.reason).toMatch(/未观测/);
  });
});

describe("过滤器 10 超买", () => {
  // 横盘后连拉 5 个板：RSI 100 / 乖离 19.9% / J 115 → 4 分，严重超买
  const up = [...Array(35).fill(10), 11, 12.1, 13.31, 14.64, 16.1];

  it("严重超买 → 否决 —— 买在这里，止损离得近、目标位离得远，盈亏比天然差", () => {
    const o = runFilters(viewFor({ closes: up }), "600000", "卫星").outcomes.find(o => o.name === "超买")!;
    expect(o.evaluated).toBe(true);
    expect(o.pass).toBe(false);
  });

  it("否决线可调：设到 99 等于关掉 —— 这道筛与「不限制打板」天然有张力，得留开关", () => {
    const o = runFilters(viewFor({ closes: up }), "600000", "卫星", { 超买否决分: 99 } as any)
      .outcomes.find(o => o.name === "超买")!;
    expect(o.pass).toBe(true);
  });

  it("平稳 → 通过", () => {
    const o = runFilters(viewFor({ closes: calm }), "600000", "卫星").outcomes.find(o => o.name === "超买")!;
    expect(o.pass).toBe(true);
  });

  /**
   * 两道筛各管一件事，这条把分工钉住。
   *
   * 稳步连涨（每天 +5%）的 RSI 是 100，但乖离与 J 都不报警 —— 它们衡量的是相对短均线的
   * **短期偏离**，稳步上涨时 MA5 跟得上。于是它只拿 2 分（超买），不被超买筛否决。
   * 这是对的区分：稳步趋势能持续，抛物线式急拉才是经典的短期过热。
   *
   * 而累计涨幅过大（这只票 20 日 +165%）是**位置**筛的活，它照样会被否掉。
   */
  it("稳步连涨不被超买筛否决，但会被位置筛否决 —— 短期过热与累计涨幅是两件事", () => {
    const steady = Array.from({ length: 40 }, (_, i) => 10 * Math.pow(1.05, i));
    const rep = runFilters(viewFor({ closes: steady }), "600000", "卫星");
    expect(rep.outcomes.find(o => o.name === "超买")!.pass).toBe(true);
    expect(rep.rejected).toContain("位置");
  });
});
