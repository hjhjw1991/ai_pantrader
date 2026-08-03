const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

export interface HttpOpts {
  referer?: string;
  encoding?: "utf8" | "gbk";
  timeoutMs?: number;
  retries?: number;
  retryDelayMs?: number;
}

export type HttpResult =
  | { ok: true; text: string; status: number; latencyMs: number }
  | { ok: false; error: string; status?: number; latencyMs: number };

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function once(url: string, o: HttpOpts): Promise<HttpResult> {
  const started = Date.now();
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), o.timeoutMs ?? 20_000);
  try {
    const headers: Record<string, string> = { "User-Agent": UA };
    if (o.referer) headers["Referer"] = o.referer;

    const res = await fetch(url, { headers, signal: ctl.signal });
    const buf = Buffer.from(await res.arrayBuffer());
    const latencyMs = Date.now() - started;

    if (!res.ok) return { ok: false, error: `http ${res.status}`, status: res.status, latencyMs };

    const text =
      o.encoding === "gbk" ? new TextDecoder("gbk").decode(buf) : buf.toString("utf8");

    // 空响应体是限频/封锁的典型表现，绝不当作"没有数据"
    if (!text.trim()) return { ok: false, error: "empty response body", status: res.status, latencyMs };

    return { ok: true, text, status: res.status, latencyMs };
  } catch (e: any) {
    const latencyMs = Date.now() - started;
    const msg = e?.name === "AbortError" ? "timeout" : `${e?.name ?? "Error"}: ${e?.message ?? e}`;
    return { ok: false, error: msg, latencyMs };
  } finally {
    clearTimeout(timer);
  }
}

export async function httpGet(url: string, opts: HttpOpts = {}): Promise<HttpResult> {
  const retries = opts.retries ?? 2;
  const delay = opts.retryDelayMs ?? 1_000;
  let last: HttpResult = { ok: false, error: "not attempted", latencyMs: 0 };
  for (let i = 0; i <= retries; i++) {
    last = await once(url, opts);
    if (last.ok) return last;
    if (i < retries) await sleep(delay * (i + 1));
  }
  return last;
}
