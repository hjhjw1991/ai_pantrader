import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  newestTsFile, shouldAttempt, handoverTo, startFreshnessGuard,
  type HandoverProbe,
} from "@/lib/data/freshness";

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "pt-fresh-")); });
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const write = (rel: string, mtimeMs: number): string => {
  const p = path.join(dir, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, "export const x = 1;\n");
  fs.utimesSync(p, mtimeMs / 1000, mtimeMs / 1000);
  return p;
};

const sleep = (ms: number): Promise<void> => new Promise<void>((r) => setTimeout(r, ms));

describe("找最新改动", () => {
  it("只认 .ts —— 改文档不该让人白等一次重启", () => {
    write("a.ts", 2000);
    write("README.md", 9000);
    expect(newestTsFile([dir], 0)?.file.endsWith("a.ts")).toBe(true);
  });

  it("只认比自己启动更晚的改动", () => {
    write("old.ts", 1000);
    expect(newestTsFile([dir], 5000)).toBeNull();
    expect(newestTsFile([dir], 500)?.file.endsWith("old.ts")).toBe(true);
  });

  it("递归子目录，取最新那个", () => {
    write("x/one.ts", 1000);
    const two = write("x/deep/two.ts", 3000);
    expect(newestTsFile([dir], 0)?.file).toBe(two);
  });

  it("空目录 / 不存在的目录返回 null，不抛", () => {
    expect(newestTsFile([dir], 0)).toBeNull();
    expect(newestTsFile([path.join(dir, "不存在")], 0)).toBeNull();
  });
});

describe("同一份改动只试一次交班", () => {
  it("mtime 没变大就不再试 —— 否则每分钟崩一次，采集照样没人做", () => {
    expect(shouldAttempt(1000, null)).toBe(true);
    expect(shouldAttempt(1000, 1000)).toBe(false);
    expect(shouldAttempt(1001, 1000)).toBe(true);
  });
});

/** 造一个假 probe；alive/lockPid 由测试按需给 */
function probe(o: {
  pid?: number | undefined;
  alive?: (pid: number) => boolean;
  lockPid?: () => number | undefined;
}): HandoverProbe & { logs: string[]; released: number } {
  const state = { logs: [] as string[], released: 0 };
  return {
    logs: state.logs,
    get released() { return state.released; },
    spawn: () => o.pid,
    releaseLock: () => { state.released++; },
    alive: o.alive ?? (() => true),
    lockPid: o.lockPid ?? (() => undefined),
    sleep,
    now: () => Date.now(),
    log: (m) => state.logs.push(m),
  } as HandoverProbe & { logs: string[]; released: number };
}

describe("交班", () => {
  it("spawn 都失败了 → 不算交班成功", async () => {
    const p = probe({ pid: undefined });
    const r = await handoverTo(p, 100, 10, 10);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("spawn-failed");
  });

  it("必须先让位再等 —— 握着锁等，接班进程永远拿不到锁（2026-10-08 13:47 两个进程一起没的直接原因）", async () => {
    const p = probe({ pid: 555, alive: () => false });
    await handoverTo(p, 100, 10, 10);
    expect(p.released).toBe(1);
  });

  it("接班进程启动即崩 → 不算成功（2026-10-08 一上午数据全丢的直接原因）", async () => {
    const p = probe({ pid: 555, alive: () => false });
    const r = await handoverTo(p, 100, 10, 10);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("child-died");
    expect(p.logs.join()).toContain("本进程继续跑");
  });

  it("进程活着但一直没拿到锁 → 超时也不算成功", async () => {
    const p = probe({ pid: 777, alive: () => true, lockPid: () => 999 });
    const r = await handoverTo(p, 60, 10, 10);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("timeout");
  });

  it("锁变成接班进程的 pid 才算真接住了", async () => {
    const p = probe({ pid: 777, alive: () => true, lockPid: () => 777 });
    const r = await handoverTo(p, 100, 10, 10);
    expect(r.ok).toBe(true);
    expect(r.reason).toBe("handed-over");
    expect(r.childPid).toBe(777);
  });

  it("轮询等得到：接班进程慢一点起来也算成功", async () => {
    let ticks = 0;
    const p = probe({
      pid: 888,
      alive: () => true,
      // 前 3 次查锁还不是它的 pid（tsx 还在编译），第 4 次才是
      lockPid: () => (++ticks >= 4 ? 888 : undefined),
    });
    const r = await handoverTo(p, 5000, 10, 10);
    expect(r.ok).toBe(true);
  });

  it("拿到锁之后才崩也要抓到 —— 自愈/迁移阶段崩掉同样没人为我采集", async () => {
    let alive = true;
    const p = probe({
      pid: 999,
      alive: () => alive,
      lockPid: () => 999,
    });
    const started = handoverTo(p, 5000, 10, 50);
    // 模拟：拿到锁、观察期里才崩
    await sleep(20);
    alive = false;
    const r = await started;
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("child-died");
  });
});

describe("新鲜度守卫（端到端）", () => {
  const guardDeps = (o: {
    spawn: () => number | undefined;
    alive: (pid: number) => boolean;
    lockPid: () => number | undefined;
    lockPath: string;
    retake: () => boolean;
    settleMs?: number;
  }) => {
    const calls = { stop: 0, exit: 0, retake: 0, release: 0 };
    const handle = startFreshnessGuard(0, {
      roots: [dir],
      busy: () => false,
      spawn: o.spawn,
      lockPath: o.lockPath,
      releaseLock: () => { calls.release++; },
      retakeLock: () => { calls.retake++; return o.retake(); },
      lockPid: o.lockPid,
      alive: o.alive,
      stop: () => { calls.stop++; },
      exit: () => { calls.exit++; },
      sleep,
      now: () => Date.now(),
      log: () => {},
      everyMs: 10,
      settleMs: o.settleMs ?? 0,
      graceMs: 2000, pollMs: 10, verifyMs: 10,
    });
    return { calls, handle };
  };

  it("交班失败：不退出、不停止采集，并把锁拿回来", async () => {
    write("changed.ts", 1000);
    const { calls, handle } = guardDeps({
      spawn: () => 555,
      alive: () => false,             // 启动即崩
      lockPid: () => undefined,
      lockPath: path.join(dir, "scheduler.pid"),
      retake: () => true,
    });

    await sleep(150);
    handle.stop();

    expect(calls.release).toBeGreaterThan(0);   // 让过位
    expect(calls.retake).toBeGreaterThan(0);    // 锁拿回来了
    expect(calls.stop).toBe(0);                 // 绝不能停采集
    expect(calls.exit).toBe(0);                 // 绝不能退出
  });

  it("交班失败且锁被别人接管：退出不算丢数据（有人在采）", async () => {
    write("changed.ts", 1000);
    const { calls, handle } = guardDeps({
      spawn: () => 555,
      alive: () => false,
      lockPid: () => undefined,
      lockPath: path.join(dir, "scheduler.pid"),
      retake: () => false,            // 拿不回来：别的活进程已经持锁
    });

    await sleep(150);
    handle.stop();

    expect(calls.stop).toBe(1);
    expect(calls.exit).toBe(1);
  });

  it("交班成功才停采集并退出，且不抢锁", async () => {
    write("changed.ts", 1000);
    const { calls, handle } = guardDeps({
      spawn: () => 777,
      alive: () => true,              // 接班进程活着
      lockPid: () => 777,             // 且锁已经是它的
      lockPath: path.join(dir, "scheduler.pid"),
      retake: () => true,
    });

    await sleep(150);
    handle.stop();

    expect(calls.stop).toBe(1);
    expect(calls.exit).toBe(1);
    expect(calls.retake).toBe(0);
  });

  it("改动还在写（未 settle）时不动手", async () => {
    write("changed.ts", Date.now());   // mtime 就是现在
    const { calls, handle } = guardDeps({
      spawn: () => 1, alive: () => true, lockPid: () => 1,
      lockPath: path.join(dir, "scheduler.pid"),
      retake: () => true,
      settleMs: 30_000,
    });
    await sleep(120);
    handle.stop();
    expect(calls.exit).toBe(0);
    expect(calls.release).toBe(0);
  });

  it("没有更新的代码就什么都不做", async () => {
    const { calls, handle } = guardDeps({
      spawn: () => 1, alive: () => true, lockPid: () => 1,
      lockPath: path.join(dir, "scheduler.pid"),
      retake: () => true,
      settleMs: 0,
    });
    await sleep(120);
    handle.stop();
    expect(calls.exit).toBe(0);
    expect(calls.retake).toBe(0);
    expect(calls.release).toBe(0);
  });

  it("走真实锁文件：让位后锁文件变成接班进程的 pid 才算接住", async () => {
    write("changed.ts", 1000);
    const lockPath = path.join(dir, "scheduler.pid");
    fs.writeFileSync(lockPath, "1", "utf8");      // 原本是我的 pid

    const calls = { stop: 0, exit: 0 };
    const handle = startFreshnessGuard(0, {
      roots: [dir],
      busy: () => false,
      spawn: () => 777,
      lockPath,
      // 真实行为：我把锁让出去，接班进程随后把它自己的 pid 写进去
      releaseLock: () => fs.writeFileSync(lockPath, "777", "utf8"),
      retakeLock: () => true,
      alive: () => true,
      stop: () => { calls.stop++; },
      exit: () => { calls.exit++; },
      sleep, now: () => Date.now(), log: () => {},
      everyMs: 10, settleMs: 0, graceMs: 2000, pollMs: 10, verifyMs: 10,
    });

    await sleep(150);
    handle.stop();
    expect(calls.stop).toBe(1);
    expect(calls.exit).toBe(1);
  });

  it("有 job 在跑时不动手 —— 半路退会留下 running 残行", async () => {
    write("changed.ts", 1000);
    const calls = { stop: 0, exit: 0, retake: 0, release: 0 };
    const handle = startFreshnessGuard(0, {
      roots: [dir],
      busy: () => true,
      spawn: () => 555,
      lockPath: path.join(dir, "scheduler.pid"),
      releaseLock: () => { calls.release++; },
      retakeLock: () => { calls.retake++; return true; },
      alive: () => true,
      stop: () => { calls.stop++; },
      exit: () => { calls.exit++; },
      sleep, now: () => Date.now(), log: () => {},
      everyMs: 10, settleMs: 0, graceMs: 2000, pollMs: 10, verifyMs: 10,
    });
    await sleep(120);
    handle.stop();
    expect(calls.release).toBe(0);
    expect(calls.exit).toBe(0);
  });
});
