import { describe, it, expect } from "vitest";
import { CircuitBreaker } from "@/lib/data/health";

describe("CircuitBreaker", () => {
  it("连续 3 次失败后熔断", () => {
    const cb = new CircuitBreaker(3, 60_000);
    expect(cb.isOpen()).toBe(false);
    cb.record(false); cb.record(false);
    expect(cb.isOpen()).toBe(false);
    cb.record(false);
    expect(cb.isOpen()).toBe(true);
  });

  it("中途成功会清零计数", () => {
    const cb = new CircuitBreaker(3, 60_000);
    cb.record(false); cb.record(false); cb.record(true); cb.record(false);
    expect(cb.isOpen()).toBe(false);
  });

  it("冷却期过后自动恢复", () => {
    let now = 1_000_000;
    const cb = new CircuitBreaker(3, 60_000, () => now);
    cb.record(false); cb.record(false); cb.record(false);
    expect(cb.isOpen()).toBe(true);
    now += 60_001;
    expect(cb.isOpen()).toBe(false);
  });
});
