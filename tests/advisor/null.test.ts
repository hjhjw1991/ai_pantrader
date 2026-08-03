import { describe, it, expect } from "vitest";
import { DEFAULT_SLOTS } from "@/lib/contracts/advisor";
import { createNullAdvisor } from "@/lib/advisor/null";
import { makeInput } from "./helpers";

describe("NullAdvisor", () => {
  it("返回全默认槽位，degraded=false —— 没有 Claude 是正常配置不是故障", async () => {
    const snap = await createNullAdvisor().advise(makeInput());
    expect(snap.mode).toBe("null");
    expect(snap.model).toBeNull();
    expect(snap.degraded).toBe(false);
    expect(snap.confidence).toBe(0);
    expect(snap.slots).toEqual(DEFAULT_SLOTS);
  });

  it("ts 取 view.asOf 而不是 Date.now —— 回测按 ts 回放，用真实时间会错轴", async () => {
    const snap = await createNullAdvisor().advise(makeInput({ asOf: "2026-07-31T14:30:00+08:00" }));
    expect(snap.ts).toBe("2026-07-31T14:30:00+08:00");
  });

  it("promptHash 稳定：同实例多次、跨实例都一致", async () => {
    const a = await createNullAdvisor().advise(makeInput());
    const b = await createNullAdvisor().advise(makeInput());
    expect(a.promptHash).toBe(b.promptHash);
    expect(a.promptHash.length).toBeGreaterThan(0);
  });

  it("inputSnapshotHash 随输入变化，同输入不变", async () => {
    const adv = createNullAdvisor();
    const a = await adv.advise(makeInput());
    const b = await adv.advise(makeInput());
    const c = await adv.advise(makeInput({ asOf: "2026-08-04T09:30:00+08:00" }));
    expect(a.inputSnapshotHash).toBe(b.inputSnapshotHash);
    expect(a.inputSnapshotHash).not.toBe(c.inputSnapshotHash);
  });

  it("返回的槽位是副本，调用方改它不污染 DEFAULT_SLOTS", async () => {
    const snap = await createNullAdvisor().advise(makeInput());
    snap.slots.scoreAdjust["600123"] = 1;
    snap.slots.gearOverride = "防守";
    expect(DEFAULT_SLOTS.scoreAdjust).toEqual({});
    expect(DEFAULT_SLOTS.gearOverride).toBeNull();
  });
});
