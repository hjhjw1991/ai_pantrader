import type { Db } from "@/lib/db";

export class CircuitBreaker {
  private fails = 0;
  private openedAt = 0;

  constructor(
    private threshold = 3,
    private cooldownMs = 60 * 60 * 1000,
    private now: () => number = Date.now
  ) {}

  record(ok: boolean): void {
    if (ok) { this.fails = 0; this.openedAt = 0; return; }
    this.fails++;
    if (this.fails >= this.threshold && this.openedAt === 0) this.openedAt = this.now();
  }

  isOpen(): boolean {
    if (this.openedAt === 0) return false;
    if (this.now() - this.openedAt >= this.cooldownMs) { this.reset(); return false; }
    return true;
  }

  reset(): void { this.fails = 0; this.openedAt = 0; }
}

/**
 * 按 key（实际用主机名）分桶的熔断器集合。
 *
 * 熔断粒度必须是主机而非数据源：东财的限流是 per-host 的，
 * 源级熔断会在轮换到第 3 个主机时就掐断剩余主机，让多主机降级完全失效
 * （实测：10 个主机里后 7 个全部返回 "circuit open"，一次都没真正请求）。
 */
export class BreakerPool {
  private pool = new Map<string, CircuitBreaker>();

  constructor(
    private threshold = 3,
    private cooldownMs = 60 * 60 * 1000,
    private now: () => number = Date.now
  ) {}

  for(key: string): CircuitBreaker {
    let b = this.pool.get(key);
    if (!b) {
      b = new CircuitBreaker(this.threshold, this.cooldownMs, this.now);
      this.pool.set(key, b);
    }
    return b;
  }

  /** 所有已知 key 都处于熔断状态时为 true；没有任何 key 时为 false */
  allOpen(): boolean {
    if (this.pool.size === 0) return false;
    for (const b of this.pool.values()) if (!b.isOpen()) return false;
    return true;
  }

  reset(): void { this.pool.clear(); }
}

export function recordHealth(
  db: Db, source: string, ok: boolean, latencyMs: number, err?: string
): void {
  db.prepare(
    `INSERT OR REPLACE INTO source_health (source, ts, ok, latency_ms, err)
     VALUES (?, ?, ?, ?, ?)`
  ).run(source, new Date().toISOString(), ok ? 1 : 0, latencyMs, err ?? null);
}
