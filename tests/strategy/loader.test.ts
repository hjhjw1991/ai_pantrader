/**
 * 加载 / 热加载 / 写回。
 *
 * 写回这一段的验收标准只有一条：**注释与排版一个字节都不能动**。
 * strategy.yaml 的注释记的是"为什么是这个阈值"，那是几次复盘换来的；
 * load→dump 往返会把它们全部冲掉，对一个靠纪律赚钱的系统来说这个代价高于面板便利。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  loadStrategyFile, parseStrategy, defaultStrategyPath, createStrategyStore,
  writeParamInText, writeStrategyParam, accountRule, takeProfitRules,
  StrategyConfigError,
} from "@/lib/strategy/loader";

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "pt-strat-")); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

const SRC = `# 顶部注释：这份文件是唯一真相源
id: default
version: 1.0.0

择时:
  # 防守 = 0 仓，不是轻仓
  仓位档位:  { 进攻: 0.7, 中性: 0.4, 防守: 0.0 }
  防守触发:  { 跌停家数>: 30, 权重杀跌: true }
选股:
  过滤器阈值: { 位置涨幅上限: 50, 换手上限: 15, 振幅上限: 10 }   # 行尾注释
  主线识别:  { 板块涨幅榜TopN: 3, 必查链: [半导体全链, 军工] }
持仓:
  贼王账户:  { 止损: -0.05, 灾难位: -0.08, 止损确认: 收盘, 止盈: [0.08减半, 0.15清] }
  价值账户:  { 止损: 逻辑破坏, 加仓: 逆势分批 }
组合风控:
  总仓位上限: 0.8
  单票最大占比: 0.15
  单行业最大占比: 0.35
  核心卫星比例: { 核心: 0.6, 卫星: 0.4 }
`;

function writeSrc(name = "strategy.yaml", src = SRC): string {
  const p = path.join(dir, name);
  fs.writeFileSync(p, src);
  return p;
}

describe("加载", () => {
  it("默认路径就是 config/strategy.yaml，且真实存在", () => {
    expect(defaultStrategyPath().endsWith("config/strategy.yaml")).toBe(true);
    expect(fs.existsSync(defaultStrategyPath())).toBe(true);
  });

  it("仓库自带的默认策略能加载", () => {
    const s = loadStrategyFile(defaultStrategyPath());
    expect(s.config.id).toBe("default");
    expect(s.raw).toContain("择时");
  });

  it("非法值时抛 StrategyConfigError，带行号与文件名", () => {
    const p = writeSrc("bad.yaml", SRC.replace("防守: 0.0", "防守: 0.3"));
    let err: unknown = null;
    try { loadStrategyFile(p); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(StrategyConfigError);
    const e = err as StrategyConfigError;
    expect(e.issues.some(i => i.path.join(".") === "择时.仓位档位.防守")).toBe(true);
    expect(e.message).toContain("第 7 行");
    expect(e.message).toContain("bad.yaml");
  });

  it("文件不存在时报出路径，不返回空配置", () => {
    expect(() => loadStrategyFile(path.join(dir, "无.yaml"))).toThrow(/无\.yaml/);
  });

  it("parseStrategy 直接吃字符串", () => {
    expect(parseStrategy(SRC).config.组合风控.总仓位上限).toBe(0.8);
  });
});

describe("热加载", () => {
  it("文件改了之后 get() 拿到新值，不用重启", () => {
    const p = writeSrc();
    const store = createStrategyStore(p);
    expect(store.get().组合风控.总仓位上限).toBe(0.8);

    fs.writeFileSync(p, SRC.replace("总仓位上限: 0.8", "总仓位上限: 0.6"));
    expect(store.get().组合风控.总仓位上限).toBe(0.6);
  });

  it("文件没变时不重复解析（reads 计数不涨）", () => {
    const p = writeSrc();
    const store = createStrategyStore(p);
    store.get(); store.get(); store.get();
    expect(store.stats().parses).toBe(1);
  });

  it("改坏了之后 get() 抛错，但保留上一份可用配置供降级", () => {
    const p = writeSrc();
    const store = createStrategyStore(p);
    const good = store.get();

    fs.writeFileSync(p, SRC.replace("防守: 0.0", "防守: 0.3"));
    expect(() => store.get()).toThrow(StrategyConfigError);
    // 盘中改坏一个参数不该让整套盘面停摆：last() 给出最后一份通过校验的配置
    expect(store.last()!.组合风控.总仓位上限).toBe(good.组合风控.总仓位上限);
    expect(store.lastError()).toBeInstanceOf(StrategyConfigError);
  });
});

describe("写回：注释与排版必须原样保留", () => {
  it("改一个 flow 映射里的数字，其余字节完全不变", () => {
    const out = writeParamInText(SRC, ["择时", "仓位档位", "进攻"], 0.65);
    expect(out).toContain("仓位档位:  { 进攻: 0.65, 中性: 0.4, 防守: 0.0 }");
    expect(out).toContain("# 顶部注释：这份文件是唯一真相源");
    expect(out).toContain("  # 防守 = 0 仓，不是轻仓");
    expect(out).toContain("# 行尾注释");
    // 除了那一处，逐行比对必须只有一行不同
    const diff = SRC.split("\n").filter((l, i) => l !== out.split("\n")[i]);
    expect(diff).toHaveLength(1);
  });

  it("改块映射里的数字", () => {
    const out = writeParamInText(SRC, ["组合风控", "总仓位上限"], 0.7);
    expect(out).toContain("总仓位上限: 0.7");
    expect(out.split("\n").filter((l, i) => l !== SRC.split("\n")[i])).toHaveLength(1);
  });

  it("改列表里的一个元素", () => {
    const out = writeParamInText(SRC, ["选股", "主线识别", "必查链", "1"], "军工电网");
    expect(out).toContain("必查链: [半导体全链, 军工电网]");
  });

  it("改布尔与字符串", () => {
    expect(writeParamInText(SRC, ["择时", "防守触发", "权重杀跌"], false))
      .toContain("权重杀跌: false");
    expect(writeParamInText(SRC, ["持仓", "贼王账户", "止损确认"], "盘中"))
      .toContain("止损确认: 盘中");
  });

  it("路径不存在时抛错，绝不退化成整份 dump", () => {
    // 退化成 dump 就是静默把用户的注释全删了。宁可拒绝写。
    expect(() => writeParamInText(SRC, ["组合风控", "不存在的键"], 1))
      .toThrow(/不存在|找不到/);
  });

  it("目标不是纯量（是一整段）时拒绝写", () => {
    expect(() => writeParamInText(SRC, ["组合风控"], 1)).toThrow(/纯量|标量/);
  });

  it("写入会破坏合法性的值时拒绝落盘，文件保持原样", () => {
    const p = writeSrc();
    expect(() => writeStrategyParam(p, ["择时", "仓位档位", "防守"], 0.3))
      .toThrow(StrategyConfigError);
    expect(fs.readFileSync(p, "utf8")).toBe(SRC);
  });

  it("落盘成功后重新加载得到新值，且注释还在", () => {
    const p = writeSrc();
    writeStrategyParam(p, ["组合风控", "单票最大占比"], 0.12);
    const s = loadStrategyFile(p);
    expect(s.config.组合风控.单票最大占比).toBe(0.12);
    expect(s.raw).toContain("# 顶部注释：这份文件是唯一真相源");
  });

  it("写回带引号的纯量时保留引号", () => {
    const src = `id: t\nversion: 1.0.0\n名字: "旧值"  # 注释\n`;
    const out = writeParamInText(src, ["名字"], "新值");
    expect(out).toBe(`id: t\nversion: 1.0.0\n名字: "新值"  # 注释\n`);
  });

  it("字符串里有特殊字符时加引号，不产出坏 YAML", () => {
    const out = writeParamInText(SRC, ["持仓", "贼王账户", "止损确认"], "收盘: 是");
    expect(() => parseStrategy(out)).not.toThrow();
  });
});

describe("账户规则读取（契约用 贼王/价值，YAML 写 贼王账户/价值账户）", () => {
  it("两种键名都读得到", () => {
    const cfg = parseStrategy(SRC).config;
    expect(accountRule(cfg, "贼王")["止损"]).toBe(-0.05);
    expect(accountRule(cfg, "价值")["止损"]).toBe("逻辑破坏");
    const cfg2 = parseStrategy(SRC.replace("贼王账户:", "贼王:")).config;
    expect(accountRule(cfg2, "贼王")["止损"]).toBe(-0.05);
  });

  it("止盈字符串解析成阈值 + 动作", () => {
    const cfg = parseStrategy(SRC).config;
    expect(takeProfitRules(cfg, "贼王")).toEqual([
      { pnl: 0.08, action: "减仓", raw: "0.08减半" },
      { pnl: 0.15, action: "清仓", raw: "0.15清" },
    ]);
  });

  it("止盈写法看不懂时返回空并留下原文，不猜", () => {
    const cfg = parseStrategy(SRC.replace("止盈: [0.08减半, 0.15清]", "止盈: [涨多了就卖]")).config;
    expect(takeProfitRules(cfg, "贼王")).toEqual([]);
  });

  it("没配置的账户返回空对象", () => {
    const cfg = parseStrategy(SRC.replace(/  价值账户:.*\n/, "")).config;
    expect(accountRule(cfg, "价值")).toEqual({});
  });
});
