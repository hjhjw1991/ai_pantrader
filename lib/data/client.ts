import { httpGet, type HttpOpts, type HttpResult } from "@/lib/data/http";
import { TokenBucket } from "@/lib/data/ratelimit";
import { CircuitBreaker, recordHealth } from "@/lib/data/health";
import type { Db } from "@/lib/db";

export interface SourceClient {
  source: string;
  get(url: string, opts?: HttpOpts): Promise<HttpResult>;
  breaker: CircuitBreaker;
}

const registry = new Map<string, SourceClient>();

export function createClient(
  source: string,
  o: { minIntervalMs?: number; db?: Db } = {}
): SourceClient {
  const existing = registry.get(source);
  if (existing) return existing;

  const bucket = new TokenBucket(o.minIntervalMs ?? 300);
  const breaker = new CircuitBreaker(3, 60 * 60 * 1000);

  const client: SourceClient = {
    source,
    breaker,
    async get(url, opts) {
      if (breaker.isOpen()) {
        return { ok: false, error: `circuit open for ${source}`, latencyMs: 0 };
      }
      await bucket.take();
      const r = await httpGet(url, opts);
      breaker.record(r.ok);
      if (o.db) recordHealth(o.db, source, r.ok, r.latencyMs, r.ok ? undefined : r.error);
      return r;
    },
  };
  registry.set(source, client);
  return client;
}

export function resetClients(): void { registry.clear(); }
