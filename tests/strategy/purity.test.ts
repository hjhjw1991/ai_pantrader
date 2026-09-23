/**
 * spec §17 断言 3 在这里也守一遍，别等 CI 才发现：
 *   grep -rE "\bdb\.|prisma\.|sqlite" lib/strategy/ 必须零命中。
 *
 * 注意这条断言是**按字面 grep** 的，连注释里都不能出现那几个标识符 ——
 * 所以这里的正则也照字面来，别聪明地只查代码不查注释。
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const DIR = join(process.cwd(), "lib", "strategy");

/**
 * 递归枚举，**必须递归**：v2 的槽位实现都在 lib/strategy/v2/ 子目录里，
 * 而原来这里只扫顶层 —— 也就是说新加的五个槽从落地那天起就不在纯度断言的射程内。
 * 一条只覆盖一半目录的架构断言，比没有更危险：它让人以为已经守住了。
 */
function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir)) {
    const full = join(dir, e);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (e.endsWith(".ts")) out.push(relative(DIR, full));
  }
  return out;
}

const files = walk(DIR);
const read = (f: string): string => readFileSync(join(DIR, f), "utf8");

describe("lib/strategy 纯度", () => {
  it("源文件可枚举，且包含 v2 子目录", () => {
    expect(files.length).toBeGreaterThanOrEqual(5);
    expect(files.some(f => f.includes("v2"))).toBe(true);
  });

  it("断言 3：不许直接碰存储", () => {
    const re = /\bdb\.|prisma\.|sqlite/;
    for (const f of files) {
      expect(re.test(read(f)), `${f} 直接碰了存储 —— 数据只能从 PointInTimeView 进来`).toBe(false);
    }
  });

  it("引擎不取系统时间：现在只能来自 view.asOf", () => {
    const src = read("engine.ts");
    expect(src).not.toContain("Date" + ".now");
    // new Date("2026-08-03T00:00:00Z") 这种是纯日期算术，允许；
    // new Date() 无参构造才是读时钟。
    expect(src).not.toMatch(/new Date\(\s*\)/);
  });

  it("引擎不 import 具体因子实现，只依赖注册表接口", () => {
    const src = read("engine.ts");
    expect(src).not.toMatch(/from\s+"@\/lib\/factors/);
    expect(src).toContain("FactorRegistry");
  });

  it("策略层不发网络请求", () => {
    for (const f of files) {
      const src = read(f);
      expect(src, `${f}`).not.toContain("f" + "etch(");
      expect(src, `${f}`).not.toContain("ax" + "ios");
    }
  });

  /**
   * 挂单价格必须是原始价。
   *
   * 触发价、止损价要挂进券商，必须是市场上真实存在的数字 —— 后复权价（浦发今天
   * 约 160 元，而它实际在 9 元附近交易）挂出去就是一个不存在的价位。
   * 而混用不会报错：人看信号卡时不会觉得 162.61 有什么不对，它看起来就是个价格。
   *
   * 注意这条**不适用于涨跌停判定**。那里用复权涨跌幅才是对的：交易所的涨停价
   * = **除权参考价** × (1±限幅)，不是昨天的原始收盘价。实测 21,161 个除权日里，
   * 原始涨跌幅会造出 2,320 个假跌停、漏掉 186 个真涨停。limit-up.ts 用的
   * adjClose 正是这个口径，所以它不在这条守卫的范围里（上一版曾错把它列进来）。
   */
  it("定价路径不许碰复权价", () => {
    for (const adj of ["adjBars", "periodBars"]) {
      expect(read("engine.ts"), `v1 引擎的触发价/止损价必须用原始价（命中 ${adj}）`)
        .not.toContain(adj);
    }
  });

  /**
   * registry.ts 也在白名单里：它和 loader 同类 —— 配置文件的管道，不是决策逻辑。
   * 放它进来不削弱这套断言，因为真正要守的那条（断言 3：不许碰存储）
   * 仍然罩着它，而且是它被从 lib/strategy 里切出一半到 lib/ledger 的原因。
   */
  it("除 loader/package/registry 外不碰文件系统 —— 只有它们负责读写 YAML 与策略包", () => {
    for (const f of files) {
      if (f === "loader.ts" || f === "package.ts" || f === "index.ts" || f === "registry.ts") continue;
      expect(read(f), `${f} 出现了文件系统访问`).not.toMatch(/from\s+"node:fs"/);
    }
  });
});
