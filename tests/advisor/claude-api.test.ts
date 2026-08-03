import { describe, it, expect, vi } from "vitest";
import { DEFAULT_SLOTS } from "@/lib/contracts/advisor";
import { createClaudeApiAdvisor } from "@/lib/advisor/claude-api";
import { makeInput } from "./helpers";

const body = (slots: unknown, extra: Record<string, unknown> = {}) => ({
  id: "msg_1",
  model: "claude-opus-5",
  stop_reason: "end_turn",
  content: [
    { type: "thinking", thinking: "" },
    { type: "text", text: JSON.stringify({ slots, confidence: 0.6 }) },
  ],
  ...extra,
});

const jsonRes = (obj: unknown, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });

describe("ClaudeApiAdvisor", () => {
  it("没有 API key 时直接降级，不发请求，不抛错", async () => {
    const fetchImpl = vi.fn();
    const snap = await createClaudeApiAdvisor({ env: {}, fetchImpl: fetchImpl as any }).advise(makeInput());
    expect(snap.degraded).toBe(true);
    expect(snap.slots).toEqual(DEFAULT_SLOTS);
    expect(snap.mode).toBe("claude-api");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("从环境变量读 key", async () => {
    const fetchImpl = vi.fn(async () => jsonRes(body({ gearOverride: "防守" })));
    const snap = await createClaudeApiAdvisor({
      env: { ANTHROPIC_API_KEY: "sk-test" },
      fetchImpl: fetchImpl as any,
    }).advise(makeInput());
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(snap.degraded).toBe(false);
    expect(snap.slots.gearOverride).toBe("防守");
  });

  it("请求头带 x-api-key 与 anthropic-version，body 不带被移除的采样参数", async () => {
    let init: RequestInit | undefined;
    const fetchImpl = vi.fn(async (_u: any, i: any) => {
      init = i;
      return jsonRes(body({}));
    });
    await createClaudeApiAdvisor({ apiKey: "sk-test", fetchImpl: fetchImpl as any }).advise(makeInput());
    const headers = init!.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe("sk-test");
    expect(headers["anthropic-version"]).toBe("2023-06-01");
    const sent = JSON.parse(String(init!.body));
    expect(sent.model).toBe("claude-opus-5");
    expect(sent).not.toHaveProperty("temperature");
    expect(sent).not.toHaveProperty("top_p");
    expect(sent).not.toHaveProperty("top_k");
  });

  it("HTTP 非 2xx 降级", async () => {
    const fetchImpl = vi.fn(async () => jsonRes({ error: { type: "rate_limit_error" } }, 429));
    const snap = await createClaudeApiAdvisor({ apiKey: "k", fetchImpl: fetchImpl as any }).advise(makeInput());
    expect(snap.degraded).toBe(true);
  });

  it("400 时去掉可选 beta 参数重试一次 —— 别让一个不可用的 beta 瘫掉整条通道", async () => {
    const sent: Array<Record<string, string>> = [];
    const fetchImpl = vi.fn(async (_u: any, i: any) => {
      sent.push(i.headers);
      return sent.length === 1
        ? jsonRes({ error: { type: "invalid_request_error" } }, 400)
        : jsonRes(body({ narrative: "重试成功" }));
    });
    const snap = await createClaudeApiAdvisor({ apiKey: "k", fetchImpl: fetchImpl as any }).advise(makeInput());
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(sent[0]["anthropic-beta"]).toBeDefined();
    expect(sent[1]["anthropic-beta"]).toBeUndefined();
    expect(snap.degraded).toBe(false);
    expect(snap.slots.narrative).toBe("重试成功");
  });

  it("重试后仍 400 则降级，不再无限重试", async () => {
    const fetchImpl = vi.fn(async () => jsonRes({ error: {} }, 400));
    const snap = await createClaudeApiAdvisor({ apiKey: "k", fetchImpl: fetchImpl as any }).advise(makeInput());
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(snap.degraded).toBe(true);
  });

  it("body 畸形降级，不抛错", async () => {
    const fetchImpl = vi.fn(async () => new Response("<html>502</html>", { status: 200 }));
    const snap = await createClaudeApiAdvisor({ apiKey: "k", fetchImpl: fetchImpl as any }).advise(makeInput());
    expect(snap.degraded).toBe(true);
    expect(snap.slots).toEqual(DEFAULT_SLOTS);
  });

  it("fetch 直接 reject 也不让 advise 拒绝", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNRESET");
    });
    await expect(
      createClaudeApiAdvisor({ apiKey: "k", fetchImpl: fetchImpl as any }).advise(makeInput()),
    ).resolves.toMatchObject({ degraded: true });
  });

  it("stop_reason=refusal 视为降级 —— 安全分类器拒答时 content 可能为空", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonRes({ id: "m", model: "claude-opus-5", stop_reason: "refusal", content: [] }),
    );
    const snap = await createClaudeApiAdvisor({ apiKey: "k", fetchImpl: fetchImpl as any }).advise(makeInput());
    expect(snap.degraded).toBe(true);
  });

  it("超时降级：挂住的请求被 abort", async () => {
    const fetchImpl = vi.fn(
      (_u: any, i: any) =>
        new Promise<Response>((_res, rej) => {
          i.signal.addEventListener("abort", () => rej(new DOMException("aborted", "AbortError")));
        }),
    );
    const snap = await createClaudeApiAdvisor({
      apiKey: "k",
      timeoutMs: 20,
      fetchImpl: fetchImpl as any,
    }).advise(makeInput());
    expect(snap.degraded).toBe(true);
  });
});
