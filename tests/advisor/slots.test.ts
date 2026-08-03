import { describe, it, expect } from "vitest";
import { DEFAULT_SLOTS } from "@/lib/contracts/advisor";
import {
  validateSlots,
  isDefaultSlots,
  cloneDefaultSlots,
  MAX_EXTRA_SECTORS,
  MAX_RISK_LEN,
} from "@/lib/advisor/slots";

describe("validateSlots", () => {
  it("完全合法的槽位原样通过", () => {
    const { slots, rejections } = validateSlots({
      gearOverride: "防守",
      scoreAdjust: { "600123": 0.4, "300750": -0.8 },
      extraSectors: ["光伏", "军工"],
      risks: { "600123": "连板高位，追高风险" },
      narrative: "缩量反弹，主线未确认",
    });
    expect(rejections).toEqual([]);
    expect(slots.gearOverride).toBe("防守");
    expect(slots.scoreAdjust).toEqual({ "600123": 0.4, "300750": -0.8 });
    expect(slots.extraSectors).toEqual(["光伏", "军工"]);
    expect(slots.risks).toEqual({ "600123": "连板高位，追高风险" });
    expect(slots.narrative).toBe("缩量反弹，主线未确认");
  });

  it("未知档位字符串被拒绝并回落该槽默认值", () => {
    const { slots, rejections } = validateSlots({ gearOverride: "满仓干" });
    expect(slots.gearOverride).toBeNull();
    expect(rejections.map(r => r.slot)).toContain("gearOverride");
  });

  it("scoreAdjust 超出 -1~1 的条目被丢弃，合法条目保留", () => {
    const { slots, rejections } = validateSlots({
      scoreAdjust: { "600123": 1.5, "300750": -3, "000001": 0.5 },
    });
    expect(slots.scoreAdjust).toEqual({ "000001": 0.5 });
    expect(rejections.filter(r => r.slot === "scoreAdjust")).toHaveLength(2);
  });

  it("scoreAdjust 非数字（NaN/字符串/Infinity）被丢弃", () => {
    const { slots } = validateSlots({
      scoreAdjust: { a: "0.5", b: NaN, c: Infinity, d: null },
    });
    expect(slots.scoreAdjust).toEqual({});
  });

  it("给了 knownCodes 时，不在候选池的代码被拒绝 —— 模型不能凭空造票", () => {
    const { slots, rejections } = validateSlots(
      { scoreAdjust: { "600123": 0.3, "999999": 0.3 }, risks: { "888888": "x" } },
      { knownCodes: ["600123"] },
    );
    expect(slots.scoreAdjust).toEqual({ "600123": 0.3 });
    expect(slots.risks).toEqual({});
    expect(rejections.some(r => r.key === "999999")).toBe(true);
    expect(rejections.some(r => r.key === "888888")).toBe(true);
  });

  it("extraSectors 去重、去空白、限量，非字符串丢弃", () => {
    const many = Array.from({ length: MAX_EXTRA_SECTORS + 5 }, (_, i) => `板块${i}`);
    const { slots } = validateSlots({ extraSectors: [" 光伏 ", "光伏", "", 42, ...many] });
    expect(slots.extraSectors.length).toBeLessThanOrEqual(MAX_EXTRA_SECTORS);
    expect(slots.extraSectors[0]).toBe("光伏");
    expect(slots.extraSectors.filter(s => s === "光伏")).toHaveLength(1);
  });

  it("risks 过长或空值被丢弃 —— 它会原样进信号卡", () => {
    const { slots, rejections } = validateSlots({
      risks: { "600123": "x".repeat(MAX_RISK_LEN + 1), "300750": "  ", "000001": "商誉减值" },
    });
    expect(slots.risks).toEqual({ "000001": "商誉减值" });
    expect(rejections.filter(r => r.slot === "risks")).toHaveLength(2);
  });

  it("narrative 非字符串或过长回落 null", () => {
    expect(validateSlots({ narrative: 123 }).slots.narrative).toBeNull();
    expect(validateSlots({ narrative: "x".repeat(5000) }).slots.narrative).toBeNull();
  });

  it("整体垃圾输入（null/数组/字符串）全部回落默认值且不抛错", () => {
    for (const junk of [null, undefined, 42, "oops", [], true]) {
      const { slots } = validateSlots(junk);
      expect(isDefaultSlots(slots)).toBe(true);
    }
  });

  it("兼容数组线格式 [{code,delta}] / [{code,risk}] —— 严格 JSON Schema 不支持任意键 map", () => {
    const { slots } = validateSlots({
      scoreAdjust: [{ code: "600123", delta: 0.2 }, { code: "300750", delta: 9 }],
      risks: [{ code: "600123", risk: "高位" }],
    });
    expect(slots.scoreAdjust).toEqual({ "600123": 0.2 });
    expect(slots.risks).toEqual({ "600123": "高位" });
  });

  it("多余的未知槽位被忽略 —— Claude 不能新增槽", () => {
    const { slots } = validateSlots({ 一键清仓: true, gearOverride: "中性" });
    expect(Object.keys(slots).sort()).toEqual(Object.keys(DEFAULT_SLOTS).sort());
  });

  it("cloneDefaultSlots 返回独立副本，改它不污染 DEFAULT_SLOTS", () => {
    const a = cloneDefaultSlots();
    a.scoreAdjust["600123"] = 1;
    a.extraSectors.push("x");
    expect(DEFAULT_SLOTS.scoreAdjust).toEqual({});
    expect(DEFAULT_SLOTS.extraSectors).toEqual([]);
    expect(isDefaultSlots(cloneDefaultSlots())).toBe(true);
  });
});
