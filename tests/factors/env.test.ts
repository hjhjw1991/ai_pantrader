import { describe, it, expect } from "vitest";
import { ENV_FACTORS, marketBreadth } from "@/lib/factors/env";
import type { FactorSpec, PointInTimeView } from "@/lib/contracts";
import { makeView, bar, sealedBar, sec, ztRow, weekdays } from "./view-double";

function run<T>(name: string, view: PointInTimeView, params: Record<string, unknown> = {}) {
  const spec = ENV_FACTORS.find(f => f.name === name) as FactorSpec<T> | undefined;
  if (!spec) throw new Error(`没有注册因子 ${name}`);
  return spec.fn({ view, params: { ...spec.defaults, ...params } });
}

const ds = weekdays("2026-07-27", 6);      // 6 个交易日
const today = ds[5], yest = ds[4];

/** 造一个 n 只票的市场：前 up 只上涨、其中 zt 只封板，后面的下跌、dt 只跌停 */
function market(opts: { up: number; zt: number; down: number; dt: number; idxPct: number }) {
  const securities = [] as ReturnType<typeof sec>[];
  const bars: Record<string, any[]> = {};
  const mk = (code: string, pcts: number[], sealLast: boolean) => {
    let c = 10;
    const arr = [bar(code, ds[0], c)];
    for (let i = 1; i < ds.length; i++) {
      const p = pcts[i - 1] ?? 0;
      const nc = Math.round(c * (1 + p / 100) * 100) / 100;
      const isLast = i === ds.length - 1;
      arr.push(isLast && sealLast
        ? sealedBar(code, ds[i], c, p)
        : (isLast && p < -9.8
          ? bar(code, ds[i], nc, { h: Math.round(c * 0.99 * 100) / 100, l: nc })
          : bar(code, ds[i], nc)));
      c = nc;
    }
    bars[code] = arr;
  };

  let n = 0;
  for (let i = 0; i < opts.zt; i++, n++) {
    const code = `60${String(1000 + n)}`;
    securities.push(sec(code, "主板")); mk(code, [1, 1, 1, 1, 9.9], true);
  }
  for (let i = 0; i < opts.up - opts.zt; i++, n++) {
    const code = `60${String(1000 + n)}`;
    securities.push(sec(code, "主板")); mk(code, [1, 1, 1, 1, 2], false);
  }
  for (let i = 0; i < opts.dt; i++, n++) {
    const code = `60${String(1000 + n)}`;
    securities.push(sec(code, "主板")); mk(code, [-1, -1, -1, -1, -9.9], false);
  }
  for (let i = 0; i < opts.down - opts.dt; i++, n++) {
    const code = `60${String(1000 + n)}`;
    securities.push(sec(code, "主板")); mk(code, [-1, -1, -1, -1, -2], false);
  }
  // 指数
  const idxCloses = [3000, 3000, 3000, 3000, 3000, 3000 * (1 + opts.idxPct / 100)];
  bars["sh000001"] = ds.map((d, i) => bar("sh000001", d, Math.round(idxCloses[i] * 100) / 100));
  return { securities, bars };
}

describe("marketBreadth", () => {
  const m = market({ up: 6, zt: 2, down: 4, dt: 1, idxPct: 1 });
  const view = makeView({ asOf: today, ...m });

  it("涨跌家数与涨停跌停家数", () => {
    const b = marketBreadth(view, today);
    expect(b.up).toBe(6);
    expect(b.down).toBe(4);
    expect(b.limitUp).toBe(2);
    expect(b.limitDown).toBe(1);
  });

  it("最后一根日线日期不是目标日的票记为 unknown，不当成平盘", () => {
    const v2 = makeView({
      asOf: today,
      securities: [...m.securities, sec("600999", "主板")],
      bars: { ...m.bars, "600999": [bar("600999", ds[0], 10)] },   // 之后停牌
    });
    const b = marketBreadth(v2, today);
    expect(b.unknown).toBe(1);
    expect(b.flat).toBe(0);
  });
});

describe("环境因子", () => {
  const strong = makeView({ asOf: today, ...market({ up: 40, zt: 12, down: 5, dt: 0, idxPct: 1.5 }) });
  const weak = makeView({ asOf: today, ...market({ up: 5, zt: 0, down: 40, dt: 8, idxPct: -1.8 }) });

  it("涨停家数 = 日线代理，必须标 proxy 且置信度打折", () => {
    const r = run<number>("涨停家数", strong);
    expect(r.value).toBe(12);
    expect(r.provenance).toBe("proxy");
    expect(r.confidence).toBeLessThan(1);
    expect(r.confidence).toBeGreaterThan(0);
  });

  it("跌停家数", () => {
    expect(run<number>("跌停家数", weak).value).toBe(8);
  });

  it("盘面强度：强势market 明显高于弱势market，且落在 0~100", () => {
    const a = run<number>("盘面强度", strong);
    const b = run<number>("盘面强度", weak);
    expect(a.value).toBeGreaterThan(b.value);
    expect(a.value).toBeGreaterThan(60);
    expect(b.value).toBeLessThan(40);
    for (const r of [a, b]) {
      expect(r.value).toBeGreaterThanOrEqual(0);
      expect(r.value).toBeLessThanOrEqual(100);
      expect(r.provenance).toBe("proxy");
    }
  });

  it("情绪温度：过热 vs 冰点", () => {
    const a = run<number>("情绪温度", strong);
    const b = run<number>("情绪温度", weak);
    expect(a.value).toBeGreaterThan(b.value);
    expect(b.label).toBeTruthy();
    expect(a.label).toBeTruthy();
  });

  it("赚钱效应：上涨占比高 → 分值高", () => {
    expect(run<number>("赚钱效应", strong).value)
      .toBeGreaterThan(run<number>("赚钱效应", weak).value);
  });

  it("赚钱效应会把昨日涨停股今日表现算进去", () => {
    // 昨天封板的票今天大跌 → 打板亏钱 → 分值必须低于同breadth但昨涨停跟涨的情形
    const m = market({ up: 20, zt: 3, down: 20, dt: 0, idxPct: 0 });
    const ztCode = "601000";
    const base = makeView({ asOf: today, ...m, zt: { [yest]: [ztRow(yest, ztCode)] } });
    const r = run<number>("赚钱效应", base);
    expect(r.inputs?.["昨涨停今日均涨幅"]).not.toBeUndefined();
  });
});

describe("连板高度", () => {
  const m = market({ up: 3, zt: 3, down: 1, dt: 0, idxPct: 0.5 });

  it("有真快照时用 zt_pool 的 lbc，标 real", () => {
    const view = makeView({
      asOf: today, ...m,
      zt: { [today]: [ztRow(today, "601000", { lbc: 4 }), ztRow(today, "601001", { lbc: 2 })] },
    });
    const r = run<number>("连板高度", view);
    expect(r.value).toBe(4);
    expect(r.provenance).toBe("real");
    expect(r.inputs?.["最高板龙头"]).toBe("601000");
  });

  it("无真快照时退化为日线代理，标 proxy", () => {
    const view = makeView({ asOf: today, ...m });
    const r = run<number>("连板高度", view);
    expect(r.provenance).toBe("proxy");
    expect(r.confidence).toBeLessThan(0.8);
  });

  it("强制代理开关让 §10.3 的相关性审计能在有真快照的日期上取到代理值", () => {
    const view = makeView({
      asOf: today, ...m,
      zt: { [today]: [ztRow(today, "601000", { lbc: 4 })] },
    });
    const real = run<number>("连板高度", view);
    const proxy = run<number>("连板高度", view, { 强制代理: true });
    expect(real.provenance).toBe("real");
    expect(proxy.provenance).toBe("proxy");
    expect(proxy.value).toBe(1);          // 日线只看得到 1 板，真值 4 板 —— 这就是代理误差
    expect(real.value).toBe(4);
  });
});

describe("代理还原不了的东西不许假造", () => {
  const m = market({ up: 3, zt: 3, down: 1, dt: 0, idxPct: 0.5 });

  it("炸板率：有真快照 → 有值且 real", () => {
    const view = makeView({
      asOf: today, ...m,
      zt: {
        [today]: [
          ztRow(today, "601000", { openTimes: 2 }),
          ztRow(today, "601001", { openTimes: 0 }),
          ztRow(today, "601002", { openTimes: 1 }),
        ],
      },
    });
    const r = run<number | null>("炸板率", view);
    expect(r.value).toBeCloseTo(2 / 3, 6);
    expect(r.provenance).toBe("real");
    expect(r.confidence).toBeGreaterThan(0.8);
  });

  it("炸板率：无真快照 → value 为 null、confidence 0，不用日线瞎凑一个 0", () => {
    const r = run<number | null>("炸板率", makeView({ asOf: today, ...m }));
    expect(r.value).toBeNull();
    expect(r.confidence).toBe(0);
    expect(r.label).toContain("无");
  });

  it("封单强度：无真快照 → null / 0 置信", () => {
    const r = run<number | null>("封单强度", makeView({ asOf: today, ...m }));
    expect(r.value).toBeNull();
    expect(r.confidence).toBe(0);
  });

  it("封单强度：有真快照 → 均值", () => {
    const view = makeView({
      asOf: today, ...m,
      zt: { [today]: [ztRow(today, "601000", { sealAmt: 2e8 }), ztRow(today, "601001", { sealAmt: 1e8 })] },
    });
    expect(run<number | null>("封单强度", view).value).toBe(1.5e8);
  });
});
