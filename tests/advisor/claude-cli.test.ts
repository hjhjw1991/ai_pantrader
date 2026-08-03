import { describe, it, expect, vi } from "vitest";
import { DEFAULT_SLOTS } from "@/lib/contracts/advisor";
import { createClaudeCliAdvisor, type SpawnFn, type SpawnResult } from "@/lib/advisor/claude-cli";
import { makeInput } from "./helpers";

const ok = (stdout: string): SpawnResult => ({ code: 0, stdout, stderr: "", timedOut: false });

/** 探测 --version 成功、正式调用返回给定 stdout 的假 spawn */
function fakeSpawn(payload: string | SpawnResult, sink?: { calls: Array<{ args: string[]; stdin?: string }> }): SpawnFn {
  return async (_cmd, args, o) => {
    sink?.calls.push({ args, stdin: o.stdin });
    if (args.includes("--version")) return ok("2.1.220 (Claude Code)");
    return typeof payload === "string" ? ok(payload) : payload;
  };
}

const wrap = (slots: unknown, confidence = 0.7) =>
  JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    result: JSON.stringify({ slots, confidence }),
  });

describe("ClaudeCliAdvisor", () => {
  it("二进制不存在（ENOENT）时降级返回默认槽位，不抛错", async () => {
    const spawn: SpawnFn = async () => ({ code: null, stdout: "", stderr: "", timedOut: false, spawnError: "ENOENT" });
    const snap = await createClaudeCliAdvisor({ spawn }).advise(makeInput());
    expect(snap.degraded).toBe(true);
    expect(snap.slots).toEqual(DEFAULT_SLOTS);
    expect(snap.mode).toBe("claude-cli");
  });

  it("返回畸形 JSON 时降级为默认槽位，不抛错", async () => {
    const snap = await createClaudeCliAdvisor({ spawn: fakeSpawn("这不是 json{{{") }).advise(makeInput());
    expect(snap.degraded).toBe(true);
    expect(snap.slots).toEqual(DEFAULT_SLOTS);
  });

  it("返回半截 JSON（被截断）时降级，不抛错", async () => {
    const snap = await createClaudeCliAdvisor({ spawn: fakeSpawn('{"type":"result","result":"{\\"slots\\":') })
      .advise(makeInput());
    expect(snap.degraded).toBe(true);
  });

  it("合法响应填入槽位，degraded=false", async () => {
    const snap = await createClaudeCliAdvisor({
      spawn: fakeSpawn(wrap({ gearOverride: "防守", scoreAdjust: { "600123": -0.5 }, narrative: "缩量" })),
    }).advise(makeInput());
    expect(snap.degraded).toBe(false);
    expect(snap.slots.gearOverride).toBe("防守");
    expect(snap.slots.scoreAdjust).toEqual({ "600123": -0.5 });
    expect(snap.confidence).toBeCloseTo(0.7);
    expect(snap.model).not.toBeNull();
  });

  it("合法响应里的越界值走槽位校验回落，不算降级", async () => {
    const snap = await createClaudeCliAdvisor({
      spawn: fakeSpawn(wrap({ gearOverride: "梭哈", scoreAdjust: { "600123": 99 } })),
    }).advise(makeInput());
    expect(snap.degraded).toBe(false);
    expect(snap.slots.gearOverride).toBeNull();
    expect(snap.slots.scoreAdjust).toEqual({});
  });

  it("超时降级 —— 模型卡死不能拖住交易流程", async () => {
    const spawn: SpawnFn = async (_c, args) =>
      args.includes("--version") ? ok("x") : { code: null, stdout: "", stderr: "", timedOut: true };
    const snap = await createClaudeCliAdvisor({ spawn }).advise(makeInput());
    expect(snap.degraded).toBe(true);
    expect(snap.slots).toEqual(DEFAULT_SLOTS);
  });

  it("非零退出码降级", async () => {
    const spawn: SpawnFn = async (_c, args) =>
      args.includes("--version") ? ok("x") : { code: 1, stdout: "", stderr: "boom", timedOut: false };
    expect((await createClaudeCliAdvisor({ spawn }).advise(makeInput())).degraded).toBe(true);
  });

  it("spawn 自身抛异常也不让 advise 拒绝 —— 契约要求永不 reject", async () => {
    const spawn: SpawnFn = async () => {
      throw new Error("kaboom");
    };
    await expect(createClaudeCliAdvisor({ spawn }).advise(makeInput())).resolves.toMatchObject({ degraded: true });
  });

  it("用 -p / --output-format json / --json-schema 调用，提示词走 stdin", async () => {
    const sink = { calls: [] as Array<{ args: string[]; stdin?: string }> };
    await createClaudeCliAdvisor({ spawn: fakeSpawn(wrap({}), sink) }).advise(makeInput());
    const call = sink.calls.find(c => !c.args.includes("--version"))!;
    expect(call.args).toContain("-p");
    expect(call.args).toContain("--output-format");
    expect(call.args).toContain("json");
    expect(call.args).toContain("--json-schema");
    expect(call.stdin).toContain("600123");
  });

  it("默认 spawn 遇到不存在的二进制返回 spawnError 而不是抛错", async () => {
    const { nodeSpawn } = await import("@/lib/advisor/claude-cli");
    const r = await nodeSpawn("pantrader-no-such-binary-xyz", ["--version"], { timeoutMs: 3000 });
    expect(r.spawnError ?? "").not.toBe("");
    expect(r.code).toBeNull();
  });

  it("不注入 spawn 时，本机没有 claude 也只是降级（走真实探测）", async () => {
    const snap = await createClaudeCliAdvisor({ bin: "pantrader-no-such-binary-xyz" }).advise(makeInput());
    expect(snap.degraded).toBe(true);
    expect(snap.slots).toEqual(DEFAULT_SLOTS);
  });

  it("探测只做一次，后续复用结果", async () => {
    const spawn = vi.fn(fakeSpawn(wrap({})));
    const adv = createClaudeCliAdvisor({ spawn });
    await adv.advise(makeInput());
    await adv.advise(makeInput());
    const probes = spawn.mock.calls.filter(c => (c[1] as string[]).includes("--version"));
    expect(probes).toHaveLength(1);
  });
});
