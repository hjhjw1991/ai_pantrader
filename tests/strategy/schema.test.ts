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

  it("默认 YAML 的每个账户都带齐引擎需要的键", () => {
    // 不再断言具体账户名 —— 默认 YAML 里的账户只是示例，用户随时改名或删掉。
    // 要保证的是：凡是配了的账户，可交易板块与仓位桶都在，否则引擎会静默给它 0 预算
    const r = validateStrategyYaml(DEFAULT_YAML);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const held = r.config.持仓 as unknown as Record<string, Record<string, unknown>>;
    const accounts = Object.keys(held);
    expect(accounts.length).toBeGreaterThan(0);
    for (const a of accounts) {
      expect(Array.isArray(held[a].可交易板块), `${a} 缺 可交易板块`).toBe(true);
      expect(["核心", "卫星"], `${a} 的 仓位桶 非法`).toContain(held[a].仓位桶);
      expect(held[a].止损, `${a} 缺 止损`).toBeDefined();
    }
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

  it("用户自定义的账户名一律接受 —— 账户是用户的资产组织方式，不是程序的枚举", () => {
    // 这条以前是反的：旧实现维护账户名白名单，改个名字就被否决。
    // 账户叫什么是用户的决定，schema 无权过问。
    for (const name of ["打板账户", "长线", "港股通", "my-account", "A组"]) {
      const r = validateStrategyYaml(bad(base.replace("贼王账户:", `${name}:`)));
      expect(r.ok, `账户名 ${name} 应被接受`).toBe(true);
    }
  });

  it("空账户键仍然否决 —— 那是真的没法处理，不是命名自由", () => {
    const r = validateStrategyYaml(bad(base.replace("贼王账户:", '"":')));
    expect(r.ok).toBe(false);
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
