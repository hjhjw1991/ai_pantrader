/**
 * .ptstrat 策略包（spec §9.2）。
 *
 * 导入三重校验：schema 版本兼容 / 引用因子全部存在 / 参数在合法区间。
 * 三条都不许"警告后继续"—— 导进来一份因子语义漂移过的策略，
 * 回测成绩会对得上、实盘行为却变了，这种错事后无法归因。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FactorSpec } from "@/lib/contracts";
import {
  STRATEGY_SCHEMA_VERSION, exportStrategyPackage, importStrategyPackage,
  serializeStrategyPackage, parseStrategyPackage, packagePayloadSha256,
  writeStrategyPackage, readStrategyPackage, PTSTRAT_EXT,
} from "@/lib/strategy/package";
import { stubRegistry, BASE_YAML } from "./helpers";

const REG = () => stubRegistry({
  盘面强度: { value: 70 }, 跌停家数: { value: 3 }, 外围传导: { value: 0, label: "中性" },
});

function spec(name: string, version: string): FactorSpec<any> {
  return { name, version, group: "env", defaults: {}, fn: () => ({
    name, version, value: 0, provenance: "real", confidence: 1,
  }) };
}

const EXPORT_ARGS = {
  yaml: BASE_YAML,
  lock: { 盘面强度: "1.0.0", 跌停家数: "1.0.0" },
  author: "barney",
  createdAt: "2026-08-03T22:00:00.000Z",
};

describe("导出", () => {
  it("四个部分齐全，backtest_report 可选", () => {
    const pkg = exportStrategyPackage(EXPORT_ARGS);
    expect(pkg["strategy.yaml"]).toBe(BASE_YAML);
    expect(pkg["factors.lock"]).toEqual({ 盘面强度: "1.0.0", 跌停家数: "1.0.0" });
    expect(pkg["backtest_report.json"]).toBeUndefined();
    expect(pkg.meta.schema_version).toBe(STRATEGY_SCHEMA_VERSION);
    expect(pkg.meta.author).toBe("barney");
    expect(pkg.meta.created_at).toBe("2026-08-03T22:00:00.000Z");
    expect(pkg.meta.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("同一份输入导两次字节一致 —— 校验和对不上会假报导入失败", () => {
    const a = serializeStrategyPackage(exportStrategyPackage(EXPORT_ARGS));
    const b = serializeStrategyPackage(exportStrategyPackage(EXPORT_ARGS));
    expect(a).toBe(b);
  });

  it("factors.lock 的键排序输出，两台机器导出的字节序一致", () => {
    const pkg = exportStrategyPackage({
      ...EXPORT_ARGS, lock: { 跌停家数: "1.0.0", 盘面强度: "1.0.0" },
    });
    expect(Object.keys(pkg["factors.lock"])).toEqual(["盘面强度", "跌停家数"]);
  });

  it("created_at 必须由调用方给 —— 取系统时间会让同份策略每次导出哈希不同", () => {
    // @ts-expect-error 故意漏掉 createdAt
    expect(() => exportStrategyPackage({ ...EXPORT_ARGS, createdAt: undefined }))
      .toThrow(/created_at|createdAt/);
  });

  it("导出前先校验 YAML，非法策略不许打包", () => {
    expect(() => exportStrategyPackage({
      ...EXPORT_ARGS, yaml: BASE_YAML.replace("防守: 0.0", "防守: 0.2"),
    })).toThrow(/防守/);
  });

  it("策略包里不含任何数据表 —— 逻辑资产与历史资产分开搬（.ptbak 是另一个包）", () => {
    const text = serializeStrategyPackage(exportStrategyPackage(EXPORT_ARGS));
    for (const t of ["kline_daily", "quote_snapshot", "zt_pool", "lhb", "ptbak"]) {
      expect(text).not.toContain(t);
    }
  });
});

describe("导入：schema 版本", () => {
  it("同主版本通过", () => {
    const pkg = exportStrategyPackage(EXPORT_ARGS);
    pkg.meta.schema_version = "1.9.3";
    pkg.meta.sha256 = packagePayloadSha256(pkg);
    const r = importStrategyPackage(pkg, { registry: REG() });
    expect(r.schemaError).toBeNull();
  });

  it("主版本不同直接否决，并说清双方版本", () => {
    const pkg = exportStrategyPackage(EXPORT_ARGS);
    pkg.meta.schema_version = "2.0.0";
    pkg.meta.sha256 = packagePayloadSha256(pkg);
    const r = importStrategyPackage(pkg, { registry: REG() });
    expect(r.ok).toBe(false);
    expect(r.schemaError).toContain("2.0.0");
    expect(r.schemaError).toContain(STRATEGY_SCHEMA_VERSION);
  });
});

describe("导入：因子", () => {
  it("因子齐全且版本一致 → 通过", () => {
    const r = importStrategyPackage(exportStrategyPackage(EXPORT_ARGS), { registry: REG() });
    expect(r.ok).toBe(true);
    expect(r.missingFactors).toEqual([]);
    expect(r.mismatchedFactors).toEqual([]);
    expect(r.config!.id).toBe("t");
  });

  it("缺因子 → 否决 + 迁移提示列出缺的名字", () => {
    const pkg = exportStrategyPackage({
      ...EXPORT_ARGS, lock: { 盘面强度: "1.0.0", 某个不存在的因子: "1.0.0" },
    });
    const r = importStrategyPackage(pkg, { registry: REG() });
    expect(r.ok).toBe(false);
    expect(r.missingFactors).toEqual(["某个不存在的因子"]);
    expect(r.migrationHint).toContain("某个不存在的因子");
  });

  it("因子版本不匹配 → 否决 + 提示本机可用版本", () => {
    const reg = stubRegistry({});
    reg.register(spec("盘面强度", "2.1.0"));
    const pkg = exportStrategyPackage({ ...EXPORT_ARGS, lock: { 盘面强度: "1.0.0" } });
    const r = importStrategyPackage(pkg, { registry: reg });
    expect(r.ok).toBe(false);
    expect(r.mismatchedFactors).toEqual([{ name: "盘面强度", expected: "1.0.0", actual: "2.1.0" }]);
    expect(r.migrationHint).toContain("2.1.0");
    expect(r.migrationHint).toContain("1.0.0");
  });

  it("YAML 的 因子参数 段引用了未注册的因子也算缺失", () => {
    const yaml = `${BASE_YAML}因子参数:\n  幽灵因子: { 阈值: 1 }\n`;
    const pkg = exportStrategyPackage({ ...EXPORT_ARGS, yaml, lock: { 盘面强度: "1.0.0" } });
    const r = importStrategyPackage(pkg, { registry: REG() });
    expect(r.missingFactors).toContain("幽灵因子");
  });
});

describe("导入：参数区间", () => {
  it("非法值 → 否决，且报出行号", () => {
    const pkg = exportStrategyPackage(EXPORT_ARGS);
    // 绕过导出校验，模拟"别人手改过的包"
    pkg["strategy.yaml"] = BASE_YAML.replace("单票最大占比: 0.15", "单票最大占比: 1.5");
    pkg.meta.sha256 = packagePayloadSha256(pkg);
    const r = importStrategyPackage(pkg, { registry: REG() });
    expect(r.ok).toBe(false);
    expect(r.issues.some(i => i.path.join(".") === "组合风控.单票最大占比")).toBe(true);
    expect(r.issues[0].line).toBeGreaterThan(0);
    expect(r.message).toMatch(/第 \d+ 行/);
  });
});

describe("导入：完整性", () => {
  it("内容被改过而 sha256 没更新 → 报校验和错误", () => {
    const pkg = exportStrategyPackage(EXPORT_ARGS);
    pkg["strategy.yaml"] = BASE_YAML.replace("总仓位上限: 0.8", "总仓位上限: 0.5");
    const r = importStrategyPackage(pkg, { registry: REG() });
    expect(r.ok).toBe(false);
    expect(r.checksumError).toContain("sha256");
  });

  it("三个检查同时不过时全部报出来，不只报第一个", () => {
    const pkg = exportStrategyPackage({
      ...EXPORT_ARGS, lock: { 幽灵: "1.0.0" },
    });
    pkg.meta.schema_version = "9.0.0";
    pkg["strategy.yaml"] = BASE_YAML.replace("防守: 0.0", "防守: 0.4");
    pkg.meta.sha256 = packagePayloadSha256(pkg);
    const r = importStrategyPackage(pkg, { registry: REG() });
    expect(r.schemaError).not.toBeNull();
    expect(r.missingFactors.length).toBeGreaterThan(0);
    expect(r.issues.length).toBeGreaterThan(0);
  });
});

describe("落盘与读回", () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "pt-pkg-")); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it("写出再读回，导入照样通过", () => {
    const p = path.join(dir, `default${PTSTRAT_EXT}`);
    writeStrategyPackage(p, exportStrategyPackage(EXPORT_ARGS));
    const back = readStrategyPackage(p);
    expect(importStrategyPackage(back, { registry: REG() }).ok).toBe(true);
  });

  it("坏文件报错而不是返回半个包", () => {
    const p = path.join(dir, `bad${PTSTRAT_EXT}`);
    fs.writeFileSync(p, "{不是JSON");
    expect(() => readStrategyPackage(p)).toThrow(/解析|格式/);
  });

  it("缺必需部分的包报错", () => {
    expect(() => parseStrategyPackage(JSON.stringify({ meta: {} }))).toThrow(/strategy\.yaml/);
  });
});
