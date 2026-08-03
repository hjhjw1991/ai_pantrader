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

export interface ClientOpts {
  minIntervalMs?: number;
  db?: Db;
  /** 单主机连续失败多少次后熔断 */
  breakerThreshold?: number;
  /**
   * 熔断冷却时长。默认 5 分钟——定时 job 每 5 分钟一轮，跳过一轮无所谓；
   * 但一次性长任务（bootstrap 拉 56 页）需要更短，否则主机熔断后
   * 任务在自己的退避窗口内永远等不到恢复。
   */
  cooldownMs?: number;
}

export function createClient(source: string, o: ClientOpts = {}): SourceClient {
  const existing = registry.get(source);
  if (existing) return existing;

  const bucket = new TokenBucket(o.minIntervalMs ?? 300);
  const breakers = new BreakerPool(o.breakerThreshold ?? 3, o.cooldownMs ?? 5 * 60 * 1000);

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
