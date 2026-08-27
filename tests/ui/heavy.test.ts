import { describe, it, expect, beforeEach } from "vitest";
import { tryAcquire, release, currentHeavy } from "@/lib/ui/heavy";

/**
 * 重活单飞。
 *
 * 数字是这条约束的全部理由：0.38 秒/交易日 → 四年单次回测约 6 分钟，
 * 36 点的参数扫描是 36 次完整回测 → 约 3.7 小时。Node 单线程，
 * 并行跑两件不会各自快一点，只会一起变慢并且把整个网站拖住。
 */
beforeEach(() => {
  const j = currentHeavy();
  if (j) release(j);
});

describe("重活单飞锁", () => {
  it("空闲时拿得到", () => {
    const r = tryAcquire("backtest", "2022-01-01 → 2026-01-01");
    expect(r.ok).toBe(true);
  });

  it("回测占着时扫描拿不到 —— 两把独立的锁等于没锁", () => {
    const a = tryAcquire("backtest", "A");
    expect(a.ok).toBe(true);
    const b = tryAcquire("sweep", "B");
    expect(b.ok).toBe(false);
    if (b.ok) return;
    expect(b.reason).toContain("回测");
  });

  it("反过来也一样：扫描占着时回测拿不到", () => {
    tryAcquire("sweep", "网格 6×6");
    const b = tryAcquire("backtest", "X");
    expect(b.ok).toBe(false);
    if (b.ok) return;
    expect(b.reason).toContain("参数扫描");
    expect(b.reason).toContain("网格 6×6");
  });

  it("被拒时说清占着的是什么、跑了多久 —— 只说'忙'没法让人决定要不要取消", () => {
    tryAcquire("backtest", "2022-08-27 → 2026-08-27", 1_000_000);
    const b = tryAcquire("sweep", "X", 1_000_000 + 95_000);
    expect(b.ok).toBe(false);
    if (b.ok) return;
    expect(b.reason).toContain("2022-08-27 → 2026-08-27");
    expect(b.reason).toContain("95 秒");
  });

  it("释放之后下一个拿得到", () => {
    const a = tryAcquire("backtest", "A");
    expect(a.ok).toBe(true);
    if (!a.ok) return;
    release(a.job);
    expect(tryAcquire("sweep", "B").ok).toBe(true);
  });

  it("只释放自己那把：迟到的 release 不能把接手者踢掉", () => {
    const a = tryAcquire("backtest", "A");
    expect(a.ok).toBe(true);
    if (!a.ok) return;
    release(a.job);
    const b = tryAcquire("sweep", "B");
    expect(b.ok).toBe(true);
    // A 已经放过一次了，再放一次不该动到 B
    release(a.job);
    expect(currentHeavy()?.label).toBe("B");
    expect(tryAcquire("backtest", "C").ok).toBe(false);
  });

  it("锁上带着取消标志，跑的人靠它停下来", () => {
    const a = tryAcquire("backtest", "A");
    expect(a.ok).toBe(true);
    if (!a.ok) return;
    expect(a.job.abort.aborted).toBe(false);
    a.job.abort.aborted = true;
    expect(currentHeavy()!.abort.aborted).toBe(true);
  });
});
