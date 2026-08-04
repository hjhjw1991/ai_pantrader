/**
 * spec §17 断言 3 在这里也守一遍，别等 CI 才发现：
 *   grep -rE "\bdb\.|prisma\.|sqlite" lib/strategy/ 必须零命中。
 *
 * 注意这条断言是**按字面 grep** 的，连注释里都不能出现那几个标识符 ——
 * 所以这里的正则也照字面来，别聪明地只查代码不查注释。
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const DIR = join(process.cwd(), "lib", "strategy");
const files = readdirSync(DIR).filter(f => f.endsWith(".ts"));
const read = (f: string): string => readFileSync(join(DIR, f), "utf8");

describe("lib/strategy 纯度", () => {
  it("源文件可枚举", () => {
    expect(files.length).toBeGreaterThanOrEqual(5);
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

  it("除 loader/package 外不碰文件系统 —— 只有它们负责读写 YAML 与策略包", () => {
    for (const f of files) {
      if (f === "loader.ts" || f === "package.ts" || f === "index.ts") continue;
      expect(read(f), `${f} 出现了文件系统访问`).not.toMatch(/from\s+"node:fs"/);
    }
  });
});
