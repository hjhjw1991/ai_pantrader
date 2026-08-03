import { describe, it, expect } from "vitest";
import { TokenBucket } from "@/lib/data/ratelimit";

describe("TokenBucket", () => {
  it("首次调用不等待", async () => {
    const b = new TokenBucket(100);
    const t0 = Date.now();
    await b.take();
    expect(Date.now() - t0).toBeLessThan(50);
  });

  it("连续调用间隔不小于 minIntervalMs", async () => {
    const b = new TokenBucket(120);
    await b.take();
    const t0 = Date.now();
    await b.take();
    expect(Date.now() - t0).toBeGreaterThanOrEqual(100);
  });
});
