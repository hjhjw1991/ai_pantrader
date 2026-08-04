import { describe, it, expect } from "vitest";
import { shanghaiTs, shanghaiDay } from "@/lib/data/clock";

describe("shanghaiTs", () => {
  it("输出上海挂钟且不带 T —— 混格式会击穿时点比较", () => {
    const s = shanghaiTs(new Date("2026-08-03T06:47:41.774Z"));
    expect(s).toBe("2026-08-03 14:47:41.774");
    expect(s).not.toContain("T");
    expect(s).not.toContain("Z");
  });

  it("同一时刻的两种写法字符串可比 —— 这是当初的 bug 根因", () => {
    // 旧口径：UTC 带 T 的行恒大于上海挂钟的行，与真实时间无关
    const utc = new Date("2026-08-03T06:47:41Z").toISOString();
    const minuteBar = "2026-08-03 14:55:00";
    expect(utc > minuteBar).toBe(true);          // 错的：06:47Z 其实是 14:47，早于 14:55
    expect(shanghaiTs(new Date(utc)) < minuteBar).toBe(true);  // 统一后顺序正确
  });

  it("毫秒不破坏与分钟线格式的比较顺序 —— 靠前缀相等", () => {
    const withMs = shanghaiTs(new Date("2026-08-03T06:47:41.774Z"));
    expect(withMs > "2026-08-03 14:47:41").toBe(true);
    expect(withMs < "2026-08-03 14:47:42").toBe(true);
  });

  it("source_health 主键 (source, ts) 要求同秒内可区分", () => {
    const a = shanghaiTs(new Date("2026-08-03T06:47:41.100Z"));
    const b = shanghaiTs(new Date("2026-08-03T06:47:41.900Z"));
    expect(a).not.toBe(b);   // 截到秒会撞主键，历史迁移就是这么炸的
  });

  it("跨 UTC 午夜仍落在正确的上海日期", () => {
    // 22:00Z = 次日 06:00 上海
    expect(shanghaiDay(new Date("2026-08-03T22:00:00Z"))).toBe("2026-08-04");
  });

  it("上海午夜给成 00 而不是 24", () => {
    expect(shanghaiTs(new Date("2026-08-03T16:00:00Z"))).toBe("2026-08-04 00:00:00.000");
  });
});
