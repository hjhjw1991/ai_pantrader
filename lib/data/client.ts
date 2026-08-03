import { httpGet, type HttpOpts, type HttpResult } from "@/lib/data/http";
import { TokenBucket } from "@/lib/data/ratelimit";
import { BreakerPool, recordHealth, type CircuitBreaker } from "@/lib/data/health";
import type { Db } from "@/lib/db";

export interface SourceClient {
  source: string;
  get(url: string, opts?: HttpOpts): Promise<HttpResult>;
  /** 按主机名取熔断器；多主机轮换要靠它做到互不牵连 */
  breakerFor(host: string): CircuitBreaker;
  breakers: BreakerPool;
}

const registry = new Map<string, SourceClient>();

function hostOf(url: string): string {
  try { return new URL(url).hostname; } catch { return url; }
}

export function createClient(
  source: string,
  o: { minIntervalMs?: number; db?: Db } = {}
): SourceClient {
  const existing = registry.get(source);
  if (existing) return existing;

  const bucket = new TokenBucket(o.minIntervalMs ?? 300);
  const breakers = new BreakerPool(3, 60 * 60 * 1000);

  const client: SourceClient = {
    source,
    breakers,
    breakerFor: (host: string) => breakers.for(host),
    async get(url, opts) {
      const host = hostOf(url);
      const breaker = breakers.for(host);
      if (breaker.isOpen()) {
        return { ok: false, error: `circuit open for ${host}`, latencyMs: 0 };
      }
      await bucket.take();
      const r = await httpGet(url, opts);
      breaker.record(r.ok);
      if (o.db) recordHealth(o.db, `${source}:${host}`, r.ok, r.latencyMs, r.ok ? undefined : r.error);
      return r;
    },
  };
  registry.set(source, client);
  return client;
}

export function resetClients(): void { registry.clear(); }
