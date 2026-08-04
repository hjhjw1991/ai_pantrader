import { describe, it, expect } from "vitest";
import { probeAvailability } from "@/lib/advisor/availability";
import { resolveAdvisor } from "@/lib/advisor/index";
import type { SpawnFn } from "@/lib/advisor/claude-cli";

/**
 * 假 spawn 必须实现真的 SpawnFn 契约：返回 Promise<SpawnResult>，
 * 起进程失败也走返回值（spawnError）而不是抛错。
 *
 * 第一版这个假实现返回的是 EventEmitter 子进程对象，跟真契约不符 ——
 * 结果 10 个测试全绿，但接上真 nodeSpawn 立刻超时。
 * 假实现跟错的理解对齐时，测试只会验证那个错的理解。
 */
function fakeSpawn(r: {
  stdout?: string; stderr?: string; code?: number | null;
  timedOut?: boolean; spawnError?: string;
}): SpawnFn {
  return async () => ({
    code: r.code ?? 0,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
    timedOut: r.timedOut ?? false,
    spawnError: r.spawnError,
  });
}

const LOGGED_IN = JSON.stringify({
  loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty",
  email: "x@y.z", subscriptionType: "team",
});

describe("probeAvailability 三态", () => {
  it("已登录 → ready，并带出认证方式", async () => {
    const r = await probeAvailability({ spawn: fakeSpawn({ stdout: LOGGED_IN }) });
    expect(r.state).toBe("ready");
    expect(r.authMethod).toBe("claude.ai");
    expect(r.subscriptionType).toBe("team");
    expect(r.message).toMatch(/订阅额度/);
  });

  it("装了但没登录 → needs-login，且提示里带该敲的命令", async () => {
    const r = await probeAvailability({
      spawn: fakeSpawn({ stdout: JSON.stringify({ loggedIn: false }) }),
    });
    expect(r.state).toBe("needs-login");
    // 静默降级会把一条命令能解决的问题藏起来，所以必须给出可操作指令
    expect(r.message).toMatch(/auth login/);
  });

  it("没装 → absent，且说明系统仍按传统量化流程运行", async () => {
    const r = await probeAvailability({
      spawn: fakeSpawn({ spawnError: "spawn claude ENOENT", code: null }),
    });
    expect(r.state).toBe("absent");
    expect(r.message).toMatch(/传统量化流程/);
  });

  it("apiKey 认证要显式说明按 token 计费 —— 成本含义和订阅完全不同", async () => {
    const r = await probeAvailability({
      spawn: fakeSpawn({ stdout: JSON.stringify({ loggedIn: true, authMethod: "apiKey" }) }),
    });
    expect(r.state).toBe("ready");
    expect(r.message).toMatch(/计费/);
  });

  it("输出解析不了 → 按 needs-login 处理，不擅自判定可用", async () => {
    const r = await probeAvailability({ spawn: fakeSpawn({ stdout: "not json" }) });
    expect(r.state).toBe("needs-login");
  });

  it("探测卡住时超时返回，不拖住盘前流程", async () => {
    const r = await probeAvailability({
      spawn: fakeSpawn({ timedOut: true, code: null }), timeoutMs: 30,
    });
    expect(r.state).toBe("absent");
    expect(r.error).toMatch(/timed out/);
  });
});

describe("resolveAdvisor", () => {
  it("needs-login 时仍回落 NullAdvisor —— 功能完整，但提示带出去", async () => {
    const { advisor, availability } = await resolveAdvisor({
      env: { PATH: "", PANTRADER_CLAUDE_BIN: process.execPath },
      spawn: fakeSpawn({ stdout: JSON.stringify({ loggedIn: false }) }),
    });
    expect(availability.state).toBe("needs-login");
    expect(advisor.mode).toBe("null");     // 系统照跑
    expect(availability.message).toMatch(/auth login/);
  });

  it("没有 claude 也没有 key → absent + NullAdvisor", async () => {
    const { advisor, availability } = await resolveAdvisor({ env: { PATH: "" } });
    expect(availability.state).toBe("absent");
    expect(advisor.mode).toBe("null");
  });

  it("ADVISOR=null 彻底关掉，不做探测（CI 断言 1 的开关）", async () => {
    let probed = false;
    const { advisor, availability } = await resolveAdvisor({
      env: { ADVISOR: "null", PATH: "" },
      spawn: (async () => { probed = true; throw new Error("should not probe"); }) as any,
    });
    expect(advisor.mode).toBe("null");
    expect(probed).toBe(false);
    expect(availability.state).toBe("absent");
  });

  it("已登录 → 真用 claude-cli", async () => {
    const { advisor, availability } = await resolveAdvisor({
      env: { PATH: "", PANTRADER_CLAUDE_BIN: process.execPath },
      spawn: fakeSpawn({ stdout: LOGGED_IN }),
    });
    expect(availability.state).toBe("ready");
    expect(advisor.mode).toBe("claude-cli");
  });
});
