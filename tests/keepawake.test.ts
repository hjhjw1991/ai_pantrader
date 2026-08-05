import { describe, it, expect } from "vitest";
import { keepAwake, windowsScript, currentPlatform } from "@/lib/platform/keepawake";

function fakeSpawn() {
  const calls: Array<{ cmd: string; args: string[] }> = [];
  const fn = ((cmd: string, args: string[]) => {
    calls.push({ cmd, args });
    return { unref() {}, on() {}, kill() {} } as any;
  }) as any;
  return { fn, calls };
}

describe("keepAwake 平台分派", () => {
  it("macOS 用 caffeinate -is 并限时", () => {
    const { fn, calls } = fakeSpawn();
    const h = keepAwake({ seconds: 600, platform: "darwin", spawnFn: fn });
    expect(h.active).toBe(true);
    expect(calls[0].cmd).toBe("/usr/bin/caffeinate");
    expect(calls[0].args).toEqual(["-is", "-t", "600"]);
  });

  it("Windows 用 SetThreadExecutionState —— 不需要管理员，也不改用户电源计划", () => {
    const { fn, calls } = fakeSpawn();
    const h = keepAwake({ seconds: 600, platform: "win32", spawnFn: fn });
    expect(h.active).toBe(true);
    expect(calls[0].cmd).toBe("powershell.exe");
    const script = calls[0].args.join(" ");
    expect(script).toContain("SetThreadExecutionState");
    // ES_CONTINUOUS | ES_SYSTEM_REQUIRED
    expect(script).toContain("0x80000000 -bor 0x00000001");
    expect(script).toContain("Start-Sleep -Seconds 600");
  });

  it("Windows 脚本结束时归还状态，不永久禁掉休眠", () => {
    const s = windowsScript(60);
    const setCalls = s.split("SetThreadExecutionState").length - 1;
    expect(setCalls).toBe(3);            // 声明 + 置位 + 归还
    expect(s.trimEnd().endsWith("| Out-Null;")).toBe(true);
    expect(s).toContain("[Native.Power]::SetThreadExecutionState(0x80000000)");
  });

  it("Linux 明确返回不可用，而不是假装成功", () => {
    const { fn, calls } = fakeSpawn();
    const h = keepAwake({ seconds: 60, platform: "linux", spawnFn: fn });
    expect(h.active).toBe(false);
    expect(h.reason).toMatch(/无统一防休眠机制/);
    expect(calls.length).toBe(0);
  });

  it("起进程失败不抛错 —— 防休眠失败不该让采集流程崩", () => {
    const boom = (() => { throw new Error("spawn failed"); }) as any;
    const h = keepAwake({ seconds: 60, platform: "darwin", spawnFn: boom });
    expect(h.active).toBe(false);
    expect(h.reason).toMatch(/启动失败/);
  });

  it("currentPlatform 识别三平台，其余归 other", () => {
    expect(currentPlatform("darwin")).toBe("darwin");
    expect(currentPlatform("win32")).toBe("win32");
    expect(currentPlatform("linux")).toBe("linux");
    expect(currentPlatform("aix")).toBe("other");
  });
});
