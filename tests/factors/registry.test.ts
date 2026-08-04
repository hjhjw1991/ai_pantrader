import { describe, it, expect } from "vitest";
import { createRegistry, runFactor } from "@/lib/factors/registry";
import { createDefaultRegistry, defaultRegistry, ALL_FACTORS } from "@/lib/factors";
import type { FactorSpec } from "@/lib/contracts";
import { makeView } from "./view-double";

const dummy = (name: string, version = "1.0.0"): FactorSpec<number> => ({
  name, version, group: "env", defaults: { k: 2 },
  fn: ctx => ({
    name, version, value: (ctx.params.k as number) * 10,
    provenance: "real", confidence: 1,
  }),
});

describe("FactorRegistry", () => {
  it("register / get / list", () => {
    const reg = createRegistry();
    reg.register(dummy("甲"));
    reg.register(dummy("乙", "2.1.0"));
    expect(reg.get("甲")!.version).toBe("1.0.0");
    expect(reg.get("不存在")).toBeUndefined();
    expect(reg.list().map(s => s.name).sort()).toEqual(["乙", "甲"]);
  });

  it("lock() 出 name -> version，键有序（.ptstrat 的 factors.lock 要能稳定比对）", () => {
    const reg = createRegistry([dummy("乙", "2.1.0"), dummy("甲")]);
    expect(reg.lock()).toEqual({ 乙: "2.1.0", 甲: "1.0.0" });
    expect(Object.keys(reg.lock())).toEqual(Object.keys(reg.lock()).slice().sort());
    expect(JSON.stringify(reg.lock())).toBe(JSON.stringify(createRegistry([dummy("甲"), dummy("乙", "2.1.0")]).lock()));
  });

  it("重名直接报错 —— 静默覆盖会让 factors.lock 指向另一份实现", () => {
    const reg = createRegistry([dummy("甲")]);
    expect(() => reg.register(dummy("甲", "9.9.9"))).toThrow(/甲/);
  });

  it("runFactor 合并 defaults 与覆盖参数", () => {
    const spec = dummy("甲");
    const view = makeView({ asOf: "2026-08-03" });
    expect(runFactor(spec, view).value).toBe(20);
    expect(runFactor(spec, view, { k: 5 }).value).toBe(50);
  });
});

describe("默认注册表", () => {
  it("所有因子都注册进去了", () => {
    expect(defaultRegistry.list()).toHaveLength(ALL_FACTORS.length);
    for (const f of ALL_FACTORS) expect(defaultRegistry.get(f.name)).toBeDefined();
  });

  it("因子名唯一", () => {
    const names = ALL_FACTORS.map(f => f.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("每个因子都有版本号、组、默认参数", () => {
    for (const f of ALL_FACTORS) {
      expect(f.version).toMatch(/^\d+\.\d+\.\d+$/);
      expect(["env", "filter", "tech", "fund", "thermo"]).toContain(f.group);
      expect(f.defaults).toBeTypeOf("object");
    }
  });

  it("spec §8 的每个组都有因子", () => {
    const groups = new Set(ALL_FACTORS.map(f => f.group));
    for (const g of ["env", "filter", "tech", "fund", "thermo"]) expect(groups).toContain(g);
  });

  it("createDefaultRegistry 每次给新实例，改一个不影响另一个", () => {
    const a = createDefaultRegistry();
    a.register(dummy("临时因子"));
    expect(createDefaultRegistry().get("临时因子")).toBeUndefined();
    expect(defaultRegistry.get("临时因子")).toBeUndefined();
  });

  it("lock 覆盖全部因子", () => {
    expect(Object.keys(defaultRegistry.lock())).toHaveLength(ALL_FACTORS.length);
  });
});
