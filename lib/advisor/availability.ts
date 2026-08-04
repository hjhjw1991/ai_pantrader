import type { SpawnFn } from "@/lib/advisor/claude-cli";

/**
 * Advisor 可用性的三态判定。
 *
 * 目标是复用宿主已经登录的 claude，所以"没装"和"装了但没登录"必须分开处理：
 *   absent      —— 机器上没有 claude。这是正常配置，静默回落到 NullAdvisor，
 *                  按 D2 系统功能完整，不该弹任何提示去烦用户。
 *   needs-login —— 有 claude 但没登录。这是**可操作**状态，必须提示用户去登录，
 *                  静默降级等于把一个一条命令能解决的问题藏起来。
 *   ready       —— 可用。
 *
 * 判定靠 `claude auth status --json`，它不发起模型调用，所以探测本身不花钱、不计额度：
 *   {"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty",...}
 *
 * authMethod 也带出来：claude.ai 是订阅登录（额度内，无按次账单），
 * apiKey 走的是按 token 计费，两者的成本含义完全不同，值得让用户看见自己在用哪种。
 */

export type AvailabilityState = "ready" | "needs-login" | "absent";

export interface AvailabilityReport {
  state: AvailabilityState;
  /** claude.ai = 订阅登录；apiKey = 按 token 计费 */
  authMethod?: string;
  subscriptionType?: string;
  /** 给人看的一句话，needs-login 时带上该敲的命令 */
  message: string;
  /** 探测本身失败时的原始错误，便于排查（超时/权限/输出变形） */
  error?: string;
}

const PROBE_TIMEOUT_MS = 10_000;

/** 邮箱、orgId 这些不往外带：判定只需要登录状态与认证方式。 */
interface AuthStatus {
  loggedIn?: boolean;
  authMethod?: string;
  subscriptionType?: string;
}

export interface ProbeOpts {
  spawn: SpawnFn;
  bin?: string;
  timeoutMs?: number;
}

const ABSENT_MSG =
  "未检测到 claude，Advisor 关闭，系统按传统量化流程运行（手动定策略 + 回测优化）";

export async function probeAvailability(o: ProbeOpts): Promise<AvailabilityReport> {
  const bin = o.bin ?? "claude";

  // SpawnFn 的契约是「返回 Promise<SpawnResult>，起进程失败也走返回值不抛错」，
  // 所以这里不需要 try/catch 去接 ENOENT，看 spawnError 就行。
  const out = await o.spawn(bin, ["auth", "status", "--json"], {
    timeoutMs: o.timeoutMs ?? PROBE_TIMEOUT_MS,
  });

  if (out.spawnError) {
    const enoent = /ENOENT|not found/i.test(out.spawnError);
    return {
      state: "absent",
      message: enoent ? ABSENT_MSG : "claude 探测失败，Advisor 关闭，不影响其余功能",
      error: out.spawnError,
    };
  }

  if (out.timedOut) {
    // 探测卡住不能拖住盘前流程，超时即当不可用
    return {
      state: "absent",
      message: "claude 探测超时，Advisor 关闭，不影响其余功能",
      error: `claude auth status timed out after ${o.timeoutMs ?? PROBE_TIMEOUT_MS}ms`,
    };
  }

  let st: AuthStatus | null = null;
  try {
    st = JSON.parse(out.stdout.trim()) as AuthStatus;
  } catch {
    st = null;
  }

  // 输出解析不了：能跑起来说明装了，但状态不明。当作需要登录处理 ——
  // 提示用户去看一眼，比擅自判定"可用"然后在盘前卡住安全
  if (!st || typeof st.loggedIn !== "boolean") {
    return {
      state: "needs-login",
      message: `无法判定 claude 登录状态，请运行 \`${bin} auth status\` 确认；未确认前 Advisor 按关闭处理`,
      error: out.stderr.trim() || out.stdout.slice(0, 200),
    };
  }

  if (!st.loggedIn) {
    return {
      state: "needs-login",
      authMethod: st.authMethod,
      message: `claude 已安装但未登录。运行 \`${bin} auth login\` 登录后即可启用 Advisor 建议`,
    };
  }

  return {
    state: "ready",
    authMethod: st.authMethod,
    subscriptionType: st.subscriptionType,
    message: st.authMethod === "apiKey"
      ? "Advisor 可用（apiKey 认证，按 token 计费）"
      : `Advisor 可用（${st.authMethod ?? "已登录"}，走订阅额度）`,
  };
}
