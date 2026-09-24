import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { stopDaemon, commandLineOf } from "@/lib/platform/stop";
import { isAlive } from "@/lib/platform/singleton";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pt-stop-"));
const lock = path.join(dir, "scheduler.pid");
const kids: ChildProcess[] = [];
/** 起一个常驻子进程；mark 会出现在它的命令行里（模拟 scripts/daemon.ts） */
const live = (mark: string, ignoreTerm = false) => {
  const code = ignoreTerm ? "process.on('SIGTERM',()=>{});setInterval(()=>{},1e3)" : "setInterval(()=>{},1e3)";
  const c = spawn(process.execPath, ["-e", code, mark], { stdio: "ignore" });
  kids.push(c);
  return c.pid!;
};
const until = async (f: () => boolean) => { for (let i = 0; i < 50 && !f(); i++) await new Promise(r => setTimeout(r, 100)); };
afterEach(() => { for (const k of kids) try { k.kill("SIGKILL"); } catch { /* 已退出 */ } kids.length = 0; fs.rmSync(lock, { force: true }); });

describe("pnpm daemon:stop", () => {
  it("没有锁文件：报没在跑", async () => {
    expect((await stopDaemon({ lockPath: lock })).status).toBe("not-running");
  });

  it("锁里的进程早已不在：清掉僵尸锁", async () => {
    fs.writeFileSync(lock, "999999");
    const r = await stopDaemon({ lockPath: lock });
    expect(r.status).toBe("stale-lock");
    expect(fs.existsSync(lock)).toBe(false);
  });

  it("命令行对得上：结束它并删掉锁", async () => {
    const pid = live("scripts/daemon.ts");
    await until(() => (commandLineOf(pid) ?? "").includes("daemon.ts"));
    fs.writeFileSync(lock, String(pid));
    const r = await stopDaemon({ lockPath: lock });
    expect(r).toMatchObject({ status: "stopped", forced: false });
    expect(isAlive(pid)).toBe(false);
    expect(fs.existsSync(lock)).toBe(false);
  });

  it("号码被别的程序复用了：不动它", async () => {
    const pid = live("something-else.js");
    await until(() => commandLineOf(pid) !== null);
    fs.writeFileSync(lock, String(pid));
    const r = await stopDaemon({ lockPath: lock });
    expect(r.status).toBe("refused");
    expect(isAlive(pid)).toBe(true);
  });

  it("不理 SIGTERM 的：超时后强制结束", async () => {
    const pid = live("scripts/daemon.ts", true);
    await until(() => (commandLineOf(pid) ?? "").includes("daemon.ts"));
    await new Promise(r => setTimeout(r, 500));   // 等子进程跑完 -e 里注册"不理 SIGTERM"的那一句
    fs.writeFileSync(lock, String(pid));
    const r = await stopDaemon({ lockPath: lock, waitMs: 500 });
    expect(r).toMatchObject({ status: "stopped", forced: true });
    expect(isAlive(pid)).toBe(false);
  });
});
