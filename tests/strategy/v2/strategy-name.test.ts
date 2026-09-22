/**
 * 策略显示名。
 *
 * 在此之前策略只有 id，而 id 就是文件名（default / v2-试验 / …）——
 * 它是台账的归因键，改了会让历史预测对不上，所以**不能当展示名用**。
 * 于是界面上只能显示一个不敢改的技术标识，人看不出"我现在跑的是哪一套"。
 * 显示名与 id 分开之后，名字随便改，归因键纹丝不动。
 */
import { describe, it, expect } from "vitest";
import { validateStrategyYaml } from "@/lib/strategy/schema";
import { createStrategyEngine } from "@/lib/strategy/engine";
import { createV2Engine, createSlotRegistry, BASELINE_SLOTS } from "@/lib/strategy/v2";
import { makeView, stubRegistry, config, sec, BASE_YAML } from "../helpers";

const D = "2026-08-03";

function card(cfg: any, which: "v1" | "v2") {
  const input = {
    view: makeView({
      asOf: `${D} 15:05:00`, tradingDays: [D], securities: [sec("600183", "主板")],
    }),
    config: cfg, phase: "盘后" as const, positions: [],
  };
  return which === "v1"
    ? createStrategyEngine({ registry: stubRegistry({}) })(input)
    : createV2Engine({
        registry: stubRegistry({}), slots: createSlotRegistry([...BASELINE_SLOTS]),
      })(input);
}

describe("YAML 的 名称 字段", () => {
  it("能解析出来", () => {
    const r = validateStrategyYaml(`名称: 候潮·稳健\n${BASE_YAML}`);
    expect(r.ok).toBe(true);
    expect((r as any).config.名称).toBe("候潮·稳健");
  });

  it("不写也合法 —— 现存策略文件一份都没有这个字段", () => {
    expect(validateStrategyYaml(BASE_YAML).ok).toBe(true);
    expect(config().名称).toBeUndefined();
  });

  it("写了就不能是空串 —— 空名字会在界面上显示成一片空白，比没有更糟", () => {
    expect(validateStrategyYaml(`名称: ""\n${BASE_YAML}`).ok).toBe(false);
  });
});

describe("信号卡带上策略名", () => {
  for (const which of ["v1", "v2"] as const) {
    it(`${which}：配了名称就用名称`, () => {
      const cfg = (validateStrategyYaml(`名称: 候潮·稳健\n${BASE_YAML}`) as any).config;
      expect(card(cfg, which).strategyName).toBe("候潮·稳健");
    });

    it(`${which}：没配名称就回落到 id，不给空值`, () => {
      const c = card(config(), which);
      expect(c.strategyName).toBe(c.strategyId);
    });

    it(`${which}：strategyId 始终是 id，不受显示名影响 —— 它是台账归因键`, () => {
      const cfg = (validateStrategyYaml(`名称: 随便改\n${BASE_YAML}`) as any).config;
      expect(card(cfg, which).strategyId).toBe("t");
    });
  }
});
