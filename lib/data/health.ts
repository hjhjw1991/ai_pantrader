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

export function recordHealth(
  db: Db, source: string, ok: boolean, latencyMs: number, err?: string
): void {
  db.prepare(
    `INSERT OR REPLACE INTO source_health (source, ts, ok, latency_ms, err)
     VALUES (?, ?, ?, ?, ?)`
  ).run(source, new Date().toISOString(), ok ? 1 : 0, latencyMs, err ?? null);
}
