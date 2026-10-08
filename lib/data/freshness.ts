import fs from "node:fs";
import path from "node:path";
import { isAlive } from "@/lib/platform/singleton";

/**
 * 代码新鲜度守卫：常驻进程发现自己引用的源码比自己更新，就交班重启。
 *
 * ── 为什么非要交班不可 ──
 *
 * Node 只在启动那一刻读一遍源码。一个连跑几天的采集进程，看不见这期间任何
 * `lib/data/collectors/*.ts` 的修改 —— 还会按旧逻辑每天写一行坏数据，而作者
 * 这边测过、提交过、以为已经修好了。2026-09-28 / 09-29 连续两天全市场的最新
 * 交易日复权因子被写成 1.0、图上历史价集体放大 5.8 倍，就是这么来的。
 *
 * ── 为什么交班这一步最危险 ──
 *
 * 交班 = 拉起新进程 + 旧进程退出。只要新进程没真的接住，采集就**凭空消失**：
 * 没人报错、没人重试，界面只是不再有数据进来。2026-10-08 白天连续两次：
 * 02:47 那次让 09:00~13:30 一整个上午的盘中快照全部丢失（不可回补）；
 * 13:47 那次被当场抓到 —— 父进程交班退出，子进程启动时看到锁还被活着的父进程
 * 占着，打印一句"已有采集进程在运行"也退了，两个进程都没了。
 *
 * 所以交班必须**先让位、再确认对方真的接住**，失败就不许退出自己。
 */

export interface NewestHit { file: string; mtime: number }

/**
 * 拉起接班进程的方式。**重点不是"拉起来"，是"让它别跟我们一起死"。**
 *
 * ── 为什么要绕一道 ──
 *
 * 2026-10-08 14:35 的事故：交班按设计走完了（让位 → 子进程拿到锁 → 观察 3 秒活着
 * → 父进程退出），接班进程 pid 21796 却在父进程退出后**一起没了**，之后 594 分钟
 * 无人采集。原因：`detached: true` 只保证"父进程正常退出时子进程不死"，
 * 保不住"整棵进程树被清理"—— 而恰恰是父进程退出这个动作，让托管它的那个临时任务
 * 判定命令结束、回收进程树。父子链还在，子进程就被一起收走。
 *
 * 实测（taskkill /F /T 杀父进程树，看心跳文件还长不长）：
 *   spawn + detached:true  → 子进程的 pid 出现在 kill 列表里，心跳停在 16 字节
 *   借 Start-Process 断链  → 子进程不在 kill 列表里，心跳 29 → 46 继续长
 *
 * 所以 Windows 上不能自己 spawn，要让一个**会立刻退出的中间进程**去启动它：
 * powershell 起来、Start-Process 拉起 daemon、powershell 退出 —— 中间这一跳断了
 * 父子链，daemon 从此无父，谁清理旧进程树都收不到它。
 *
 * 代价：拿不到接班进程的 pid（拿到的是 powershell 的）。所以交班判据不能再靠
 * "spawn 返回的 pid"，得改成看**锁归谁**（见 handoverTo 的 selfPid）。
 */
export interface DetachSpec {
  /** 要 spawn 的可执行文件 */
  file: string;
  args: string[];
  /** 接班进程 stdout 落点 */
  logPath: string;
  /** 接班进程 stderr 落点 */
  errPath: string;
  /**
   * true = 拿不到接班进程的 pid（进程树已断开）。
   * 交班判据改看"锁上的 pid 变成了不是我的某个活 pid"。
   */
  pidUnknown: boolean;
}

/** PowerShell 单引号字符串字面量：内部单引号加倍 */
function psq(s: string): string {
  return `'${String(s).replace(/'/g, "''")}'`;
}

export function detachedSpawnSpec(
  platform: NodeJS.Platform,
  execPath: string,
  argv: string[],
  logPath: string,
  errPath: string,
): DetachSpec {
  if (platform === "win32") {
    const list = argv.map(psq).join(",");
    const ps =
      `Start-Process -FilePath ${psq(execPath)} -ArgumentList @(${list}) ` +
      `-WindowStyle Hidden -RedirectStandardOutput ${psq(logPath)} ` +
      `-RedirectStandardError ${psq(errPath)}`;
    return {
      file: "powershell.exe",
      args: ["-NoProfile", "-NonInteractive", "-Command", ps],
      logPath,
      errPath,
      pidUnknown: true,
    };
  }
  // POSIX：detached 已经会 setsid，父进程退出不会有 SIGHUP，也不需要断链
  return { file: execPath, args: argv, logPath, errPath, pidUnknown: false };
}

/**
 * 找 dirs 下 mtime 晚于 sinceMs 的最新 .ts 文件。
 *
 * 只看 .ts —— 改注释和文档不该让人白等一次重启。
 * 遍历中单个文件的 stat 失败（被删 / 没权限）跳过，不该为此重启。
 */
export function newestTsFile(dirs: string[], sinceMs: number): NewestHit | null {
  let best: NewestHit | null = null;
  const walk = (dir: string): void => {
    let ents: fs.Dirent[];
    try {
      ents = fs.readdirSync(dir, { withFileTypes: true });
    } catch { return; }
    for (const ent of ents) {
      const p = path.join(dir, ent.name);
      try {
        if (ent.isDirectory()) { walk(p); continue; }
        if (!ent.name.endsWith(".ts")) continue;
        const ms = fs.statSync(p).mtimeMs;
        if (ms > sinceMs && (best === null || ms > best.mtime)) best = { file: p, mtime: ms };
      } catch { /* 忽略：文件正被编辑器重写 / 没权限 */ }
    }
  };
  for (const d of dirs) walk(d);
  return best;
}

/** 改动刚写下去时还在连着写好几个文件，等它停下来再动手 */
export const SETTLE_MS = 30_000;

/** 交班宽限：给接班进程从 spawn 到取到锁的时间（tsx 要编译 TS，冷启几秒） */
export const HANDOVER_GRACE_MS = 20_000;
export const HANDOVER_POLL_MS = 400;
/** 接住之后再观察这么久：拿到锁才崩的情况（自愈/迁移阶段）也要看得见 */
export const HANDOVER_VERIFY_MS = 3_000;

/**
 * 同一份改动只试一次交班。
 *
 * 交班失败后再试，拉起来的还是同一份会崩的代码 —— 每分钟崩一次，
 * 每次都往日志里加一行，而采集照样没人做。mtime 变大了才值得再试。
 */
export function shouldAttempt(mtime: number, lastAttempt: number | null): boolean {
  return lastAttempt === null || mtime > lastAttempt;
}

export interface HandoverProbe {
  /**
   * 拉起接班进程。返回它的 pid；
   * **断链启动时返回 undefined 是正常的**（拿不到，也不该拿 —— 见 detachedSpawnSpec），
   * 这时靠 selfPid + 锁的归属来认定"接住了"。
   */
  spawn(): number | undefined;
  /** 本进程 pid。spawn 返回 undefined 时必须给，否则无法判断锁是否被别人接管 */
  selfPid?: number;
  /**
   * 让位：把锁交出去。
   *
   * 必须**在等接班进程之前**做 —— 锁还在我手上时，它启动第一步 acquireLock 会看到
   * 一个活着的持锁进程，于是打印"已有采集进程在运行"直接退出。
   * 2026-10-08 13:47 就是这样：父进程交班退出、子进程因为抢不到锁也退出，
   * 两个都没了，锁文件被清空。
   */
  releaseLock(): void;
  /** 锁文件当前记录的 pid；文件不存在返回 undefined */
  lockPid(): number | undefined;
  /** pid 是否还活着 */
  alive(pid: number): boolean;
  sleep(ms: number): Promise<void>;
  now(): number;
  log(msg: string): void;
}

export type HandoverReason = "spawn-failed" | "child-died" | "timeout" | "handed-over";

export interface HandoverResult {
  ok: boolean;
  childPid: number | undefined;
  reason: HandoverReason;
}

/**
 * 交班：让位 → 等接班进程把锁接过去 → 再观察一会儿确认它没立刻崩。
 *
 * 判据用"锁文件的 pid 变成了接班进程的 pid"而不是"spawn 返回了 pid"：
 * spawn 成功只说明 fork 成功，说明不了 TS 能不能编译、依赖能不能加载。
 * 而锁是 daemon 启动后第一批动作之一，拿到锁 ≈ 进程真的活过来了。
 *
 * 失败时不退出、不停止采集 —— 调用方负责把锁拿回来继续跑。
 */
export async function handoverTo(
  p: HandoverProbe,
  graceMs: number = HANDOVER_GRACE_MS,
  pollMs: number = HANDOVER_POLL_MS,
  verifyMs: number = HANDOVER_VERIFY_MS,
): Promise<HandoverResult> {
  const childPid = p.spawn();
  if (childPid === undefined && p.selfPid === undefined) {
    p.log("交班失败：既拿不到接班进程 pid 也没有本进程 pid，无从确认接管，本进程继续跑");
    return { ok: false, childPid: undefined, reason: "spawn-failed" };
  }

  /**
   * 谁算"接住了"：
   *   知道 pid  → 锁上的 pid 必须正好是它（老判据）
   *   不知道 pid（断链启动）→ 锁上的 pid 必须是个活着的、且**不是我**的 pid
   * 后者其实更本质：真正重要的是有人在采集，至于那是谁拉起来的并不重要。
   */
  const takenByOther = (): number | undefined => {
    const owner = p.lockPid();
    if (owner === undefined || !p.alive(owner)) return undefined;
    if (childPid !== undefined) return owner === childPid ? owner : undefined;
    return owner !== p.selfPid ? owner : undefined;
  };

  // 让位。此刻到接班进程拿到锁之间有一段"无主"窗口（tsx 冷启几秒），
  // 这是交班必须付的代价 —— 反过来（握着锁等它）它永远拿不到锁。
  p.releaseLock();

  const who = childPid !== undefined ? `接班进程 ${childPid}` : "接班进程";
  const t0 = p.now();
  while (p.now() - t0 < graceMs) {
    // 只有真拿到了 pid 才查得动"它是不是已经死了"；断链模式下这一步做不了，
    // 只能等锁 —— 所以断链模式宁可多等一会儿也不要误判成交班失败
    if (childPid !== undefined && !p.alive(childPid)) {
      p.log(`交班失败：${who} 启动后已退出，本进程继续跑`);
      return { ok: false, childPid, reason: "child-died" };
    }
    const owner = takenByOther();
    if (owner !== undefined) {
      // 拿到锁之后还有自愈、迁移、起调度器这些活，崩在这些地方同样没人为我采集
      await p.sleep(verifyMs);
      const owner2 = takenByOther();
      if (owner2 === undefined) {
        p.log(`交班失败：${who} 拿到锁后又退出了，本进程继续跑`);
        return { ok: false, childPid: childPid ?? owner, reason: "child-died" };
      }
      return { ok: true, childPid: owner2, reason: "handed-over" };
    }
    await p.sleep(pollMs);
  }

  p.log(`交班失败：${who} 在 ${graceMs}ms 内没接管锁，本进程继续跑`);
  return { ok: false, childPid, reason: "timeout" };
}

export type WatchOutcome = "stable" | "orphaned";

export interface WatchProbe {
  /** pid 是否还活着 */
  alive(pid: number): boolean;
  /** 锁文件当前 pid；文件不存在返回 undefined */
  lockPid(): number | undefined;
  sleep(ms: number): Promise<void>;
  now(): number;
  log(msg: string): void;
}

/** 接班进程站住多久，本进程才敢退 */
export const WATCH_MS = 10 * 60 * 1000;
export const WATCH_POLL_MS = 30 * 1000;

/**
 * 交班成功之后**不许马上退出自己** —— 盯着接班进程看一会儿。
 *
 * ── 为什么非盯不可 ──
 *
 * 2026-10-08 14:35：交班每一步都走对了（让位、子拿到锁、观察 3 秒活着），父进程
 * 随即退出 —— 而**父进程退出这个动作本身**就是触发器：托管它的那个临时任务据此
 * 判定命令结束，回收整个会话的进程。接班进程 pid 21796 就这么没了，之后 594 分钟
 * 无人采集，且没有任何报错。
 *
 * 断链（detachedSpawnSpec）能躲开按进程树的回收，躲不开按会话的回收 —— 实测过：
 * 换了 Start-Process 之后，接班进程照样在命令结束那一刻消失。所以还得留住本进程：
 * 只要本进程不退出，命令就没结束，回收也不会发生。
 *
 * 本进程这时候已经 stop 过采集了，留着也不跟接班进程抢活，纯粹当监护人。
 */
export async function watchSuccessor(
  p: WatchProbe,
  childPid: number,
  watchMs: number = WATCH_MS,
  pollMs: number = WATCH_POLL_MS,
): Promise<WatchOutcome> {
  const t0 = p.now();
  while (p.now() - t0 < watchMs) {
    await p.sleep(pollMs);
    const owner = p.lockPid();
    // 锁没了 / 锁上的人死了 / 换人了 —— 都说明它没站住
    if (owner === undefined || owner !== childPid || !p.alive(owner)) {
      p.log(`接班进程 ${childPid} 已经不在了（锁上是 ${owner ?? "空"}），本进程再拉一个`);
      return "orphaned";
    }
  }
  p.log(`接班进程 ${childPid} 已稳定运行 ${Math.round(watchMs / 60000)} 分钟，本进程退出`);
  return "stable";
}

export interface GuardDeps {
  roots: string[];
  /** 有 job 在跑：等下一轮。改动不会因此消失，mtime 不会变老 */
  busy(): boolean;
  spawn(): number | undefined;
  /** 本进程 pid。断链启动时 spawn() 拿不到接班 pid，靠它来判断锁是否被别人接管 */
  selfPid?: number;
  lockPath: string;
  /** 让位：把锁交出去，好让接班进程能取到 */
  releaseLock(): void;
  /** 交班失败后把锁拿回来。返回是否拿到 —— 拿不到说明已被别的进程接管 */
  retakeLock(): boolean;
  /** 读锁文件当前 pid。默认真读 lockPath，测试可注入 */
  lockPid?(): number | undefined;
  /** pid 是否活着。默认用 singleton.ts 的 isAlive，测试可注入 */
  alive?(pid: number): boolean;
  /** 停止采集，准备退出 */
  stop(): void;
  /**
   * 交班成功后、退出之前。监护人可以借这段时间盯着接班进程，
   * 发现它没了就再拉一个（见 watchSuccessor）。不提供就等于老行为：立刻退出。
   */
  afterHandover?(childPid: number): Promise<void>;
  exit(): void;
  sleep(ms: number): Promise<void>;
  now(): number;
  log(msg: string): void;
  everyMs?: number;
  settleMs?: number;
  /** 交班宽限 / 轮询间隔 / 接住后的观察时长，测试用 */
  graceMs?: number;
  pollMs?: number;
  verifyMs?: number;
}

/** 读锁文件里的 pid；不存在或不是数字返回 undefined */
export function readLockPid(lockPath: string): number | undefined {
  try {
    const n = Number.parseInt(fs.readFileSync(lockPath, "utf8").trim(), 10);
    return Number.isInteger(n) ? n : undefined;
  } catch { return undefined; }
}

/**
 * 每分钟看一次：发现比我更新的源码就交班。
 *
 * 三道闸，每一道都是实测踩出来的：
 *   1. 有 job 在跑就不动 —— 半路退会留下 running 残行，下次还得靠回收逻辑擦屁股
 *   2. 等改动停下来（SETTLE_MS）—— 刚看到第一个文件就重启，会拉起半成品
 *   3. 交班必须真的接住（handoverTo）—— 否则采集进程凭空消失
 */
export function startFreshnessGuard(
  sinceMs: number,
  deps: GuardDeps,
): { stop(): void } {
  const everyMs = deps.everyMs ?? 60_000;
  const settleMs = deps.settleMs ?? SETTLE_MS;
  let lastAttempt: number | null = null;
  let running = false;

  /**
   * 交班没成功、锁又已经让出去了：把锁拿回来继续采；拿不回来说明别的活进程接管了，退出。
   * 让位之后**任何**失败路径都必须走这里 —— 包括 handoverTo 自己抛异常。
   * 漏掉的话，本进程照常采集却不持锁，下一个拉起的进程以为没人在采，两个一起拉快照。
   */
  const recoverLock = (): void => {
    if (deps.retakeLock()) return;   // 锁拿回来了，我继续采
    // 锁被别的活进程接管了：采集有人做，我退出不算丢数据
    deps.log("交班失败且锁已被别的进程接管，本进程退出");
    deps.stop();
    clearInterval(timer);
    deps.exit();
  };

  const timer = setInterval(() => {
    // 上一轮交班还没走完：不要并发 spawn，也不要并发判断退出
    if (running) return;
    running = true;
    /** 本轮是否已经让出锁 —— 决定出错时要不要把锁拿回来 */
    let released = false;
    void (async () => {
      try {
        if (deps.busy()) return;

        const hit = newestTsFile(deps.roots, sinceMs);
        if (hit === null) return;
        if (deps.now() - hit.mtime < settleMs) return;
        if (!shouldAttempt(hit.mtime, lastAttempt)) return;
        lastAttempt = hit.mtime;

        const r = await handoverTo({
          spawn: deps.spawn,
          selfPid: deps.selfPid,
          // 记下"已经让位"：交班中途抛错时才知道要不要把锁拿回来
          releaseLock: () => { released = true; deps.releaseLock(); },
          lockPid: deps.lockPid ?? (() => readLockPid(deps.lockPath)),
          alive: deps.alive ?? isAlive,
          sleep: deps.sleep,
          now: deps.now,
          log: deps.log,
        }, deps.graceMs, deps.pollMs, deps.verifyMs);

        if (!r.ok) {
          // spawn-failed 时根本没让位，retakeLock 是对自己已持有的锁再取一次，同样返回 true
          recoverLock();
          return;
        }

        deps.log(`检测到代码更新（${hit.file}），交班给 pid ${r.childPid}`);
        deps.stop();
        clearInterval(timer);
        // 交班之后不立刻走：本进程一退，托管本进程的临时任务就回收整个会话，
        // 接班进程陪葬（2026-10-08 14:35 那 594 分钟）。留下来盯着，它站得住再退。
        if (deps.afterHandover && r.childPid !== undefined) {
          await deps.afterHandover(r.childPid);
        }
        deps.exit();
      } catch (e) {
        deps.log(`新鲜度守卫出错：${(e as Error).message}`);
        if (released) {
          try { recoverLock(); } catch (e2) {
            deps.log(`新鲜度守卫取回锁出错：${(e2 as Error).message}`);
          }
        }
      } finally {
        running = false;
      }
    })();
  }, everyMs);
  timer.unref?.();

  return { stop: () => clearInterval(timer) };
}
