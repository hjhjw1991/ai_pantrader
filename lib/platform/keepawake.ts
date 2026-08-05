import { spawn, type ChildProcess } from "node:child_process";

/**
 * 防休眠，按平台分派。
 *
 * 为什么必需：实测这台 Mac `pmset -g custom` 显示 AC 与电池都是 `sleep 1`，
 * 空闲 1 分钟就睡。机器睡着时定时任务不触发，而全市场快照与分钟线不可回补 ——
 * 睡过去的那一段永久没有。Windows 默认电源计划同样会睡。
 *
 * 平台实现：
 *   darwin  caffeinate -is    -i 阻空闲休眠，-s 接电源时阻系统休眠
 *   win32   SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED)
 *           走 PowerShell P/Invoke。选它的理由是**不需要管理员权限**，
 *           也不改用户的电源计划 —— 改全局电源设置是副作用远超本程序职责的操作。
 *   linux   无统一机制（systemd-inhibit 不一定在），返回 no-op 并说明。
 *
 * 都管不了的两件事，任何代码都解决不了，只能明确告诉用户：
 *   1. 合盖：macOS clamshell 除非接电源+外接显示器照样睡；Windows 同理
 *   2. 关机：错过的时点不会被补齐
 */

export type Platform = "darwin" | "win32" | "linux" | "other";

export function currentPlatform(p: string = process.platform): Platform {
  return p === "darwin" || p === "win32" || p === "linux" ? p : "other";
}

export interface KeepAwakeHandle {
  platform: Platform;
  /** false = 该平台没有可用机制，调用方应提示用户手动设置电源计划 */
  active: boolean;
  reason: string;
  release(): void;
}

/** PowerShell 脚本：置位 ES_CONTINUOUS|ES_SYSTEM_REQUIRED 后阻塞，进程退出即自动失效 */
export function windowsScript(seconds: number): string {
  // ES_CONTINUOUS = 0x80000000, ES_SYSTEM_REQUIRED = 0x00000001
  return [
    "Add-Type -Name Power -Namespace Native -MemberDefinition '",
    "[DllImport(\"kernel32.dll\", SetLastError = true)]",
    "public static extern uint SetThreadExecutionState(uint esFlags);';",
    "[Native.Power]::SetThreadExecutionState(0x80000000 -bor 0x00000001) | Out-Null;",
    `Start-Sleep -Seconds ${Math.max(1, Math.round(seconds))};`,
    // 归还：清掉 CONTINUOUS，让系统恢复正常休眠策略
    "[Native.Power]::SetThreadExecutionState(0x80000000) | Out-Null;",
  ].join(" ");
}

export interface KeepAwakeOpts {
  seconds: number;
  platform?: Platform;
  /** 注入 spawn，测试用 */
  spawnFn?: typeof spawn;
}

export function keepAwake(o: KeepAwakeOpts): KeepAwakeHandle {
  const platform = o.platform ?? currentPlatform();
  const sp = o.spawnFn ?? spawn;
  const secs = Math.max(1, Math.round(o.seconds));
  let child: ChildProcess | null = null;

  const noop = (reason: string): KeepAwakeHandle => ({
    platform, active: false, reason, release() {},
  });

  try {
    if (platform === "darwin") {
      child = sp("/usr/bin/caffeinate", ["-is", "-t", String(secs)], { stdio: "ignore" });
    } else if (platform === "win32") {
      child = sp("powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command", windowsScript(secs)],
        { stdio: "ignore", windowsHide: true } as any);
    } else {
      return noop(
        `${platform} 无统一防休眠机制，请自行确认系统不会在采集时段休眠` +
        `（如 systemd-inhibit 或电源设置）`
      );
    }
  } catch (e: any) {
    // 起不来不能让采集流程崩：宁可可能休眠，也不要因为防休眠失败而不采集
    return noop(`防休眠进程启动失败：${String(e?.message ?? e)}`);
  }

  // 子进程自己会因为 -t / Start-Sleep 到点退出，不必长期持有
  child.unref?.();
  child.on?.("error", () => {});

  return {
    platform,
    active: true,
    reason: platform === "darwin"
      ? `caffeinate -is -t ${secs}`
      : `SetThreadExecutionState 保持 ${secs}s`,
    release() {
      try { child?.kill(); } catch { /* 已退出 */ }
    },
  };
}
