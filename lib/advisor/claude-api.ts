import type { Advisor, AdvisorInput, AdvisorSnapshot } from "@/lib/contracts/advisor";
import { validateSlots } from "@/lib/advisor/slots";
import { buildPrompt } from "@/lib/advisor/prompt";
import { degradedSnapshot, filledSnapshot } from "@/lib/advisor/snapshot";
import type { EnvLike } from "@/lib/advisor/env";
import { firstJsonObject } from "@/lib/advisor/json";

/**
 * ClaudeApiAdvisor —— 探测到 ANTHROPIC_API_KEY 时直连 Messages API（spec §5.1）。
 *
 * 【架构例外，刻意为之，不是漏改】
 * 项目规则是"只有 lib/data/ 可以发网络请求"，那条规则约束的是行情数据：
 * 行情必须经过限速/熔断/多源降级/落库留痕，否则源会被封、回测会被污染。
 * 这里发的不是行情，是顾问自己的传输层 —— 它没有数据源要保护，也不进
 * PointInTimeView，挂了就降级。所以走原生 fetch，不引 SDK（不加依赖）。
 * 未来读到这段的人：这行 fetch 是设计决定，别顺手搬去 lib/data/。
 *
 * 本机没有 API key，因此 key 缺失是首要路径：直接返回降级快照，不抛错、不发请求。
 */

export const ANTHROPIC_MESSAGES_URL = "https://api.anthropic.com/v1/messages";
export const ANTHROPIC_VERSION = "2023-06-01";
/** 与 CLI 通道保持一致的模型标识，A/B 才好对齐样本 */
export const API_DEFAULT_MODEL = "claude-opus-5";
export const API_DEFAULT_TIMEOUT_MS = 60_000;
/** thinking 在 Claude Opus 5 上默认开启，会占 max_tokens 额度，所以留足余量 */
export const API_DEFAULT_MAX_TOKENS = 8_192;
/** 安全分类器拒答用的 beta；一旦被拒就自动切到备用模型，比直接丢掉这次建议好 */
export const SERVER_SIDE_FALLBACK_BETA = "server-side-fallback-2026-07-01";

export interface ClaudeApiOptions {
  apiKey?: string;
  env?: EnvLike;
  model?: string;
  timeoutMs?: number;
  maxTokens?: number;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  /** 服务端 refusal 兜底。默认开；遇 400 会自动去掉它重试一次（见下） */
  serverSideFallback?: boolean;
}

function pickApiKey(opts: ClaudeApiOptions): string | null {
  const env = opts.env ?? process.env;
  const key = opts.apiKey ?? env.ANTHROPIC_API_KEY;
  return key && key.trim() ? key.trim() : null;
}

/** 从 Messages 响应里取出第一段文本。thinking 块的 text 是空的，必须跳过 */
function extractText(body: unknown): string | null {
  if (typeof body !== "object" || body === null) return null;
  const content = (body as Record<string, unknown>).content;
  if (!Array.isArray(content)) return null;
  const parts: string[] = [];
  for (const block of content) {
    if (typeof block === "object" && block !== null) {
      const b = block as Record<string, unknown>;
      if (b.type === "text" && typeof b.text === "string" && b.text.trim()) parts.push(b.text);
    }
  }
  return parts.length ? parts.join("\n") : null;
}

export function createClaudeApiAdvisor(opts: ClaudeApiOptions = {}): Advisor & {
  available(): boolean;
} {
  const model = opts.model ?? API_DEFAULT_MODEL;
  const timeoutMs = opts.timeoutMs ?? API_DEFAULT_TIMEOUT_MS;
  const maxTokens = opts.maxTokens ?? API_DEFAULT_MAX_TOKENS;
  const url = opts.baseUrl ?? ANTHROPIC_MESSAGES_URL;
  const doFetch = opts.fetchImpl ?? globalThis.fetch;
  const wantFallback = opts.serverSideFallback ?? true;

  function requestBody(withFallback: boolean, input: AdvisorInput): Record<string, unknown> {
    return {
      model,
      max_tokens: maxTokens,
      // 顾问是判断题不是研究题，effort 压到 low 控延迟与成本。
      // 不带 temperature/top_p/top_k —— 这几个参数在 Opus 5 上会直接 400。
      output_config: { effort: "low" },
      messages: [{ role: "user", content: buildPrompt(input) }],
      ...(withFallback ? { fallbacks: "default" } : {}),
    };
  }

  function headers(withFallback: boolean, apiKey: string): Record<string, string> {
    return {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": ANTHROPIC_VERSION,
      ...(withFallback ? { "anthropic-beta": SERVER_SIDE_FALLBACK_BETA } : {}),
    };
  }

  async function post(withFallback: boolean, apiKey: string, input: AdvisorInput) {
    const ctl = new AbortController();
    // 硬超时：模型挂住不能拖住盘中例程
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      return await doFetch(url, {
        method: "POST",
        headers: headers(withFallback, apiKey),
        body: JSON.stringify(requestBody(withFallback, input)),
        signal: ctl.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    mode: "claude-api" as const,
    available: () => pickApiKey(opts) !== null,

    async advise(input: AdvisorInput): Promise<AdvisorSnapshot> {
      const degraded = () => degradedSnapshot("claude-api", input, model);
      try {
        const apiKey = pickApiKey(opts);
        // 没 key 不是错误，是"这台机器没配 API 通道"。不发请求，直接降级。
        if (!apiKey) return degraded();
        if (typeof doFetch !== "function") return degraded();

        let res = await post(wantFallback, apiKey, input);
        // 400 往往意味着这个 beta / 参数在当前账号上不可用。带着它一路失败等于
        // 整条 API 通道白瘫，所以去掉可选参数原样重试一次再判死。
        if (!res.ok && res.status === 400 && wantFallback) {
          res = await post(false, apiKey, input);
        }
        if (!res.ok) return degraded();

        const body = (await res.json()) as Record<string, unknown>;
        // 安全分类器拒答时 content 可能为空数组，按不可用处理
        if (body.stop_reason === "refusal") return degraded();

        const text = extractText(body);
        if (text === null) return degraded();

        const payload = firstJsonObject(text);
        if (payload === null || typeof payload !== "object") return degraded();

        const p = payload as Record<string, unknown>;
        const raw = p.slots !== undefined ? p.slots : p;
        const validated = validateSlots(raw, { knownCodes: input.candidates.map(c => c.code) });
        const actualModel = typeof body.model === "string" ? body.model : model;
        return filledSnapshot("claude-api", input, actualModel, validated, p.confidence);
      } catch {
        // 网络异常 / abort / json 解析异常统统吃掉：契约要求 advise() 永不 reject
        return degraded();
      }
    },
  };
}
