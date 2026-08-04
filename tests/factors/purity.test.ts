/**
 * spec §17 的 CI 断言在这里也守一遍，别等 CI 才发现。
 * 断言 2：lib/factors 不许有 IO 与未来函数
 * 断言 3：不许绕过 PointInTimeView 直接读库
 * 断言 4：同份输入两次运行结果一致
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ALL_FACTORS } from "@/lib/factors";
import { makeView, sec, bar, sealedBar, ztRow, lhbRow, seatRow, quote, weekdays, seriesFrom } from "./view-double";

const DIR = join(process.cwd(), "lib", "factors");
const files = readdirSync(DIR).filter(f => f.endsWith(".ts"));

describe("lib/factors 纯度", () => {
  it("有源文件可查", () => {
    expect(files.length).toBeGreaterThan(5);
  });

  it("断言 2：无 fetch / axios / Date.now", () => {
    const banned = ["f" + "etch", "ax" + "ios", "Date" + ".now"];
    for (const f of files) {
      const src = readFileSync(join(DIR, f), "utf8");
      for (const b of banned) expect(src, `${f} 出现 ${b}`).not.toContain(b);
    }
  });

  it("断言 3：无 db. / prisma. / sqlite", () => {
    const re = /\bdb\.|prisma\.|sqlite/;
    for (const f of files) {
      expect(re.test(readFileSync(join(DIR, f), "utf8")), `${f} 直接碰了存储`).toBe(false);
    }
  });

  it("无 Math.random / 可变模块级状态（let / var 顶层声明）", () => {
    for (const f of files) {
      const src = readFileSync(join(DIR, f), "utf8");
      expect(src, `${f} 有随机数`).not.toContain("Math.random");
      expect(src.split("\n").filter(l => /^(let|var) /.test(l)), `${f} 有顶层可变状态`).toHaveLength(0);
    }
  });
});

describe("断言 4：确定性", () => {
  const ds = weekdays("2026-06-01", 30);
  const asOf = ds[29];
  const codes = ["600183", "300750", "600000"];
  const view = makeView({
    asOf,
    securities: [
      sec("600183", "主板"), sec("300750", "创业板"),
      sec("600000", "主板", { isStHistory: [{ from: "2022-01-01", to: "2023-01-01" }] }),
    ],
    bars: {
      "600183": seriesFrom("600183", ds, ds.map((_, i) => 10 + i * 0.1)),
      "300750": seriesFrom("300750", ds, ds.map((_, i) => 20 - i * 0.05)),
      "600000": [...seriesFrom("600000", ds.slice(0, 29), ds.slice(0, 29).map(() => 10)),
        sealedBar("600000", asOf, 10, 9.9)],
      "sh000001": seriesFrom("sh000001", ds, ds.map((_, i) => 3000 + i)),
    },
    quotes: { "600183": quote("600183"), "300750": quote("300750"), "600000": quote("600000") },
    zt: { [asOf]: [ztRow(asOf, "600183", { sector: "半导体", lbc: 2, openTimes: 1 })] },
    sectors: { [asOf]: [{ date: asOf, ts: `${asOf} 15:00`, sector: "半导体", pct: 3, leaderCode: "600183" }] },
    lhb: { [asOf]: [lhbRow(asOf, "600183", "1", 5e7), lhbRow(asOf, "600183", "2", 2e7)] },
    seats: { [asOf]: [seatRow(asOf, "600183", "华鑫证券上海分公司", 3e7, { riseProb3d: 70 })] },
    macro: {},
  });

  it("每个因子跑两次结果哈希一致", () => {
    for (const spec of ALL_FACTORS) {
      const params = { ...spec.defaults, code: codes[0], 账户: "贼王", 板块: "半导体" };
      const a = JSON.stringify(spec.fn({ view, params }));
      const b = JSON.stringify(spec.fn({ view, params: { ...params } }));
      expect(a, `${spec.name} 不确定`).toBe(b);
    }
  });

  it("全部因子都能在缺数据的空视图上跑通，不抛异常", () => {
    const empty = makeView({ asOf: "2026-08-03", securities: [sec("600183", "主板")] });
    for (const spec of ALL_FACTORS) {
      expect(() => spec.fn({
        view: empty,
        params: { ...spec.defaults, code: "600183", 账户: "贼王", 板块: "半导体" },
      }), `${spec.name} 在空数据上炸了`).not.toThrow();
    }
  });

  it("因子结果字段齐全", () => {
    for (const spec of ALL_FACTORS) {
      const r = spec.fn({ view, params: { ...spec.defaults, code: "600183", 账户: "贼王", 板块: "半导体" } });
      expect(r.name).toBe(spec.name);
      expect(r.version).toBe(spec.version);
      expect(["real", "proxy"]).toContain(r.provenance);
      expect(r.confidence).toBeGreaterThanOrEqual(0);
      expect(r.confidence).toBeLessThanOrEqual(1);
    }
  });

  it("日线代理出来的因子一律标 proxy（spec §10.3 要按 provenance 标红）", () => {
    const proxied = ["盘面强度", "情绪温度", "赚钱效应", "涨停家数", "跌停家数"];
    for (const name of proxied) {
      const spec = ALL_FACTORS.find(f => f.name === name)!;
      expect(spec.fn({ view, params: { ...spec.defaults } }).provenance, name).toBe("proxy");
    }
  });

  it("bar 工具可用", () => {
    expect(bar("600183", asOf, 10).date).toBe(asOf);
  });
});
