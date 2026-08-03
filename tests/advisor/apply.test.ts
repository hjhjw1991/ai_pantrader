import { describe, it, expect } from "vitest";
import { DEFAULT_SLOTS } from "@/lib/contracts/advisor";
import { applySlots } from "@/lib/advisor/apply";
import { makeCandidate, makeEnv } from "./helpers";

const GEAR_POS = { 进攻: 0.9, 中性: 0.5, 防守: 0 } as const;

describe("applySlots", () => {
  it("默认槽位不改任何东西，influenced=false", () => {
    const env = makeEnv();
    const cands = [makeCandidate()];
    const r = applySlots(env, cands, DEFAULT_SLOTS);
    expect(r.changes).toEqual([]);
    expect(r.influenced).toBe(false);
    expect(r.env).toEqual(env);
    expect(r.candidates).toEqual(cands);
  });

  it("降档被采纳：记录 gear 与 targetPosition 的 before/after，并追加归因", () => {
    const r = applySlots(makeEnv({ gear: "进攻", targetPosition: 0.9 }), [makeCandidate()], {
      ...DEFAULT_SLOTS,
      gearOverride: "防守",
    }, { gearPositions: GEAR_POS });

    expect(r.env.gear).toBe("防守");
    expect(r.env.targetPosition).toBe(0);
    expect(r.influenced).toBe(true);

    const gearChange = r.changes.find(c => c.slot === "gearOverride" && c.field === "gear")!;
    expect(gearChange.before).toBe("进攻");
    expect(gearChange.after).toBe("防守");

    const posChange = r.changes.find(c => c.field === "targetPosition")!;
    expect(posChange.before).toBe(0.9);
    expect(posChange.after).toBe(0);

    expect(r.env.reasons.some(x => x.includes("Advisor"))).toBe(true);
  });

  it("升档默认被拒绝 —— 模型不能把防守档抬成进攻档", () => {
    const r = applySlots(makeEnv({ gear: "防守", targetPosition: 0 }), [], {
      ...DEFAULT_SLOTS,
      gearOverride: "进攻",
    }, { gearPositions: GEAR_POS });
    expect(r.env.gear).toBe("防守");
    expect(r.changes).toEqual([]);
    expect(r.influenced).toBe(false);
    expect(r.rejections.some(x => x.slot === "gearOverride")).toBe(true);
  });

  it("显式 allowRiskUp 后升档才生效", () => {
    const r = applySlots(makeEnv({ gear: "防守", targetPosition: 0 }), [], {
      ...DEFAULT_SLOTS,
      gearOverride: "进攻",
    }, { gearPositions: GEAR_POS, allowRiskUp: true });
    expect(r.env.gear).toBe("进攻");
    expect(r.env.targetPosition).toBe(0.9);
  });

  it("scoreAdjust 逐票改分并留 before/after", () => {
    const cands = [makeCandidate({ code: "600123", score: 0.6 }), makeCandidate({ code: "300750", score: 0.4 })];
    const r = applySlots(makeEnv(), cands, { ...DEFAULT_SLOTS, scoreAdjust: { "600123": 0.3, "300750": -0.2 } });

    expect(r.candidates.find(c => c.code === "600123")!.score).toBeCloseTo(0.9);
    expect(r.candidates.find(c => c.code === "300750")!.score).toBeCloseTo(0.2);

    const c1 = r.changes.find(c => c.code === "600123" && c.slot === "scoreAdjust")!;
    expect(c1.before).toBeCloseTo(0.6);
    expect(c1.after).toBeCloseTo(0.9);
    expect(r.influenced).toBe(true);
    // 原始对象不被改（回测可复现 + Advisor 不该改上游状态）
    expect(cands[0].score).toBeCloseTo(0.6);
  });

  it("候选池里不存在的代码不产生任何改动，只记 rejection", () => {
    const r = applySlots(makeEnv(), [makeCandidate({ code: "600123" })], {
      ...DEFAULT_SLOTS,
      scoreAdjust: { "999999": 0.5 },
    });
    expect(r.changes).toEqual([]);
    expect(r.influenced).toBe(false);
    expect(r.rejections.some(x => x.key === "999999")).toBe(true);
  });

  it("risks 进 warnings 并计入 influenced —— 风险提示会出现在信号卡上", () => {
    const r = applySlots(makeEnv(), [makeCandidate({ code: "600123" })], {
      ...DEFAULT_SLOTS,
      risks: { "600123": "股东减持未完成" },
    });
    expect(r.warnings.join()).toContain("股东减持未完成");
    expect(r.warnings.join()).toContain("600123");
    expect(r.influenced).toBe(true);
    expect(r.changes.some(c => c.slot === "risks" && c.code === "600123")).toBe(true);
  });

  it("narrative 只展示不进决策，不算 influenced", () => {
    const r = applySlots(makeEnv(), [makeCandidate()], { ...DEFAULT_SLOTS, narrative: "情绪修复" });
    expect(r.narrative).toBe("情绪修复");
    expect(r.changes).toEqual([]);
    expect(r.influenced).toBe(false);
  });

  it("extraSectors 只透出给上层重扫，不直接改本次 env/candidates", () => {
    const r = applySlots(makeEnv(), [makeCandidate()], { ...DEFAULT_SLOTS, extraSectors: ["军工"] });
    expect(r.extraSectors).toEqual(["军工"]);
    expect(r.changes).toEqual([]);
    expect(r.influenced).toBe(false);
  });

  it("每条改动都能归因到槽位与标的", () => {
    const r = applySlots(makeEnv({ gear: "进攻", targetPosition: 0.9 }), [makeCandidate({ code: "600123" })], {
      gearOverride: "中性",
      scoreAdjust: { "600123": -0.1 },
      extraSectors: [],
      risks: { "600123": "注意分歧" },
      narrative: null,
    }, { gearPositions: GEAR_POS });
    for (const c of r.changes) {
      expect(Object.keys(DEFAULT_SLOTS)).toContain(c.slot);
      expect(c).toHaveProperty("before");
      expect(c).toHaveProperty("after");
    }
    expect(r.changes.length).toBeGreaterThanOrEqual(3);
  });
});
