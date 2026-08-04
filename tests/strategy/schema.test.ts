/**
 * 校验 + 行号定位（spec §9.2：任一不过给出具体报错行号）。
 *
 * 为什么行号是硬要求：策略包是要在机器之间搬的，导入失败时用户手上只有一个
 * 报错字符串和一份几十行的 YAML。"validation failed" 让他只能逐行猜，
 * "第 19 行 择时.仓位档位.防守 必须为 0" 让他 3 秒改完。
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { validateStrategyYaml, validateStrategyConfig, DEFAULT_STRATEGY_YAML_REL } from "@/lib/strategy/schema";

const DEFAULT_YAML = fs.readFileSync(
  path.join(process.cwd(), DEFAULT_STRATEGY_YAML_REL), "utf8");

describe("默认 strategy.yaml", () => {
  it("能通过校验", () => {
    const r = validateStrategyYaml(DEFAULT_YAML);
    if (!r.ok) console.error(r.issues);
    expect(r.ok).toBe(true);
  });

  it("字段与 spec §9.1 一字不差", () => {
    const r = validateStrategyYaml(DEFAULT_YAML);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const c = r.config;
    expect(c.择时.仓位档位).toEqual({ 进攻: 0.7, 中性: 0.4, 防守: 0.0 });
    expect(c.择时.防守触发).toEqual({ "跌停家数>": 30, 权重杀跌: true, 外围risk_off: true });
    expect(c.选股.过滤器阈值).toEqual({ 位置涨幅上限: 50, 换手上限: 15, 振幅上限: 10 });
    expect(c.选股.主线识别.板块涨幅榜TopN).toBe(3);
    expect(c.选股.主线识别.必查链).toEqual(["半导体全链", "军工", "电网", "资源"]);
    expect(c.组合风控).toEqual({
      总仓位上限: 0.8, 单票最大占比: 0.15, 单行业最大占比: 0.35,
      核心卫星比例: { 核心: 0.6, 卫星: 0.4 },
    });
  });

  it("持仓段用 spec 的 贼王账户/价值账户 写法，两账户都在", () => {
    const r = validateStrategyYaml(DEFAULT_YAML);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const held = r.config.持仓 as unknown as Record<string, Record<string, unknown>>;
    expect(held["贼王账户"]).toEqual({
      止损: -0.05, 灾难位: -0.08, 止损确认: "收盘", 止盈: ["0.08减半", "0.15清"],
    });
    expect(held["价值账户"]).toEqual({ 止损: "逻辑破坏", 加仓: "逆势分批" });
  });
});

describe("非法值报出行号与键名", () => {
  const bad = (body: string) => `id: t
version: 1.0.0
${body}`;

  const base = `择时:
  仓位档位:  { 进攻: 0.7, 中性: 0.4, 防守: 0.0 }
  防守触发:  { 跌停家数>: 30 }
选股:
  过滤器阈值: { 位置涨幅上限: 50, 换手上限: 15, 振幅上限: 10 }
  主线识别:  { 板块涨幅榜TopN: 3, 必查链: [半导体全链] }
持仓:
  贼王账户:  { 止损: -0.05 }
组合风控:
  总仓位上限: 0.8
  单票最大占比: 0.15
  单行业最大占比: 0.35
  核心卫星比例: { 核心: 0.6, 卫星: 0.4 }
`;

  it("仓位超出 0~1 时报出那一行", () => {
    const src = bad(base.replace("进攻: 0.7", "进攻: 1.7"));
    const r = validateStrategyYaml(src);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    const issue = r.issues.find(i => i.path.join(".") === "择时.仓位档位.进攻");
    expect(issue).toBeDefined();
    expect(issue!.line).toBe(4);
    expect(issue!.message).toMatch(/1|区间|0~1/);
    // 报错文本要自带位置与键名，光有结构化字段不够 —— 一堆调用方只会打印 message
    expect(r.message).toContain("第 4 行");
    expect(r.message).toContain("择时.仓位档位.进攻");
  });

  it("防守档不为 0 时否决 —— 防守 = 空仓，不是轻仓", () => {
    const src = bad(base.replace("防守: 0.0", "防守: 0.1"));
    const r = validateStrategyYaml(src);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    const issue = r.issues.find(i => i.path.join(".") === "择时.仓位档位.防守");
    expect(issue).toBeDefined();
    expect(issue!.line).toBe(4);
    expect(issue!.message).toMatch(/0/);
  });

  it("单票最大占比 > 总仓位上限时否决（互相矛盾的两个上限）", () => {
    const src = bad(base.replace("单票最大占比: 0.15", "单票最大占比: 0.9"));
    const r = validateStrategyYaml(src);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.issues.some(i => i.path.join(".") === "组合风控.单票最大占比")).toBe(true);
    expect(r.issues.find(i => i.path.join(".") === "组合风控.单票最大占比")!.line).toBe(13);
  });

  it("核心 + 卫星 != 1 时否决", () => {
    const src = bad(base.replace("卫星: 0.4", "卫星: 0.5"));
    const r = validateStrategyYaml(src);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    const issue = r.issues.find(i => i.path.join(".").startsWith("组合风控.核心卫星比例"));
    expect(issue).toBeDefined();
    expect(issue!.line).toBe(15);
  });

  it("必查链为空数组时否决 —— spec §8.2 写死不可关闭", () => {
    const src = bad(base.replace("必查链: [半导体全链]", "必查链: []"));
    const r = validateStrategyYaml(src);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.issues.some(i => i.path.join(".") === "选股.主线识别.必查链")).toBe(true);
  });

  it("缺整段时报缺失的键，行号退回该段父节点", () => {
    const src = bad(base.replace(/组合风控:[\s\S]*$/, ""));
    const r = validateStrategyYaml(src);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.issues.some(i => i.path.join(".") === "组合风控")).toBe(true);
  });

  it("YAML 语法错误也带行号", () => {
    const r = validateStrategyYaml("id: t\nversion: 1.0.0\n择时:\n  仓位档位: { 进攻: 0.7\n");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.issues[0].line).toBeGreaterThan(0);
    expect(r.message).toMatch(/第 \d+ 行/);
  });

  it("列表元素非法时行号指到列表所在行", () => {
    const src = bad(base.replace("必查链: [半导体全链]", "必查链: [半导体全链, 123]"));
    const r = validateStrategyYaml(src);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    const issue = r.issues.find(i => i.path.join(".").startsWith("选股.主线识别.必查链"));
    expect(issue).toBeDefined();
    expect(issue!.line).toBe(8);
  });

  it("version 不是语义化版本时否决", () => {
    const r = validateStrategyYaml(`id: t\nversion: v1\n${base}`);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.issues.some(i => i.path.join(".") === "version")).toBe(true);
  });

  it("持仓段两种键名都认（贼王 与 贼王账户）", () => {
    const a = validateStrategyYaml(bad(base));
    const b = validateStrategyYaml(bad(base.replace("贼王账户:", "贼王:")));
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
  });

  it("持仓账户键名写错时否决，并把认得的写法列出来", () => {
    const r = validateStrategyYaml(bad(base.replace("贼王账户:", "打板账户:")));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.message).toMatch(/贼王/);
  });
});

describe("validateStrategyConfig（无源文本时也可用）", () => {
  it("对象直接校验，行号为 null", () => {
    const r = validateStrategyConfig({ id: "t" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.issues.every(i => i.line === null)).toBe(true);
    expect(r.message.length).toBeGreaterThan(0);
  });
});
