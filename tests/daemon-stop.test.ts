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

  /**
   * Windows 上 commandLineOf 要起一次 powershell 去查 CIM，单次实测 2 秒以上，
   * 一个用例里要查两三次（等进程起来 + stopDaemon 内部核对身份），
   * 默认 5 秒的用例超时必然不够。macOS / Linux 走 ps 是毫秒级，多给的时间用不掉。
   */
  it("命令行对得上：结束它并删掉锁", async () => {
    const pid = live("scripts/daemon.ts");
    await until(() => (commandLineOf(pid) ?? "").includes("daemon.ts"));
    fs.writeFileSync(lock, String(pid));
    const r = await stopDaemon({ lockPath: lock });
    expect(r).toMatchObject({ status: "stopped", forced: false });
    expect(isAlive(pid)).toBe(false);
    expect(fs.existsSync(lock)).toBe(false);
  }, 30_000);

  it("号码被别的程序复用了：不动它", async () => {
    const pid = live("something-else.js");
    await until(() => commandLineOf(pid) !== null);
    fs.writeFileSync(lock, String(pid));
    const r = await stopDaemon({ lockPath: lock });
    expect(r.status).toBe("refused");
    expect(isAlive(pid)).toBe(true);
  }, 30_000);

  it("不理 SIGTERM 的：超时后强制结束", async () => {
    const pid = live("scripts/daemon.ts", true);
    await until(() => (commandLineOf(pid) ?? "").includes("daemon.ts"));
    await new Promise(r => setTimeout(r, 500));   // 等子进程跑完 -e 里注册"不理 SIGTERM"的那一句
    fs.writeFileSync(lock, String(pid));
    const r = await stopDaemon({ lockPath: lock, waitMs: 500 });
    /**
     * Windows 上没有「可以被忽略的 SIGTERM」：对 Windows 进程发 SIGTERM 就是终止，
     * 子进程里注册的 process.on("SIGTERM") 根本不会被调用，它直接就没了。
     * 于是等 500ms 时进程已经消失，走的是「自己退出了」那条路径，forced = false。
     *
     * 这条用例真正守的是「不理信号的进程最终也会被结束」，这一点两个平台都成立；
     * forced 这个字段只是在 Windows 上没有区分度，所以按平台分别断言。
     */
    expect(r).toMatchObject({ status: "stopped", forced: process.platform !== "win32" });
    expect(isAlive(pid)).toBe(false);
  }, 30_000);
});
