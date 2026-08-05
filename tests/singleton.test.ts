import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { acquireLock, releaseLock, isAlive } from "@/lib/platform/singleton";

let dir: string, lock: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "pt-lock-"));
  lock = path.join(dir, "scheduler.pid");
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("单实例锁", () => {
  it("首次取锁成功并写入 pid", () => {
    const r = acquireLock(lock, 1234);
    expect(r.acquired).toBe(true);
    expect(fs.readFileSync(lock, "utf8")).toBe("1234");
  });

  it("活进程持锁时第二个取不到 —— 两个进程同时拉 5888 只会互相把源打挂", () => {
    acquireLock(lock, process.pid);        // 当前进程一定活着
    const r = acquireLock(lock, 999999);
    expect(r.acquired).toBe(false);
    expect(r.heldBy).toBe(process.pid);
  });

  it("僵尸锁（进程已死）会被接管 —— 否则崩一次就再也起不来", () => {
    // 写一个几乎不可能存在的 pid
    fs.writeFileSync(lock, "4294967", "utf8");
    const r = acquireLock(lock, 4321);
    expect(r.acquired).toBe(true);
    expect(fs.readFileSync(lock, "utf8")).toBe("4321");
  });

  it("锁文件内容损坏也能接管，不抛错", () => {
    fs.writeFileSync(lock, "not-a-pid", "utf8");
    expect(acquireLock(lock, 42).acquired).toBe(true);
  });

  it("只释放自己写的锁，不误删别人接管后的锁", () => {
    acquireLock(lock, 111);
    releaseLock(lock, 222);               // 不是自己的，不该删
    expect(fs.existsSync(lock)).toBe(true);
    releaseLock(lock, 111);
    expect(fs.existsSync(lock)).toBe(false);
  });

  it("isAlive 对当前进程为真、对非法 pid 为假", () => {
    expect(isAlive(process.pid)).toBe(true);
    expect(isAlive(0)).toBe(false);
    expect(isAlive(-1)).toBe(false);
  });
});
