import { describe, it, expect } from "vitest";
import { startAwakeGuard, awakeRemainingSec } from "@/lib/data/autostart";
import { awakeWindows, hmToMinutes } from "@/lib/data/schedule";

const fmt = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

describe("防休眠守卫（原 launchd 唤醒任务搬进系统）", () => {
  const w = awakeWindows()[0];
  const inside = fmt(hmToMinutes(w.from) + 1);
  const outside = fmt(hmToMinutes(w.from) - 30);

  it("剩余秒数：时段内给到时段结束，时段外为 0", () => {
    expect(awakeRemainingSec(inside)).toBe((hmToMinutes(w.to) - hmToMinutes(inside)) * 60);
    expect(awakeRemainingSec(outside)).toBe(0);
  });

  it("晚上启动也管用：进入时段时才申请，出了时段就释放，下一个时段再申请", () => {
    let hm = outside;
    const calls: number[] = [];
    let released = 0;
    const g = startAwakeGuard(() => hm, s => { calls.push(s); return { platform: "darwin", active: true, reason: "", release: () => { released++; } }; }, 1e9);
    expect(calls).toEqual([]);                       // 启动时不在时段内：不申请
    hm = inside; g.tick();
    expect(calls).toEqual([awakeRemainingSec(inside)]);
    g.tick();
    expect(calls.length).toBe(1);                    // 同一时段内不重复申请
    hm = outside; g.tick();
    expect(released).toBe(1);                        // 出了时段就放手，不整天吊着
    hm = inside; g.tick();
    expect(calls.length).toBe(2);                    // 第二天同一时段再申请
    g.stop();
    expect(released).toBe(2);
  });
});
