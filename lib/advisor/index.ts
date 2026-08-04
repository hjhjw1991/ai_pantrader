import fs from "node:fs";
import path from "node:path";
import type { Advisor, AdvisorMode } from "@/lib/contracts/advisor";
import { createNullAdvisor } from "@/lib/advisor/null";
import { createClaudeCliAdvisor, type ClaudeCliOptions } from "@/lib/advisor/claude-cli";
import { createClaudeApiAdvisor, type ClaudeApiOptions } from "@/lib/advisor/claude-api";

import type { EnvLike } from "@/lib/advisor/env";

export type { EnvLike };
export * from "@/lib/advisor/slots";
export * from "@/lib/advisor/prompt";
export * from "@/lib/advisor/apply";
export * from "@/lib/advisor/store";
export { createNullAdvisor, NullAdvisor } from "@/lib/advisor/null";
export { createClaudeCliAdvisor } from "@/lib/advisor/claude-cli";
export { createClaudeApiAdvisor } from "@/lib/advisor/claude-api";

/**
 * 工厂 —— 全系统唯一允许对 Advisor 模式分支的地方（D2）。
 *
 * 别处再出现 `if (hasClaude)` 就说明设计歪了：那意味着有/无 Claude 变成了两套
 * 代码路径，其中一套永远缺测试，而且 spec §17 断言 1（ADVISOR=null 全绿）
 * 也就失去了意义。调用方只认 Advisor 接口，拿到谁都照同一条路走。
 */

const MODES: AdvisorMode[] = ["null", "claude-cli", "claude-api"];

export function isAdvisorMode(v: unknown): v is AdvisorMode {
  return typeof v === "string" && (MODES as string[]).includes(v);
}

/** 在 PATH 里找 claude 可执行文件。同步、廉价，够工厂用 */
export function findClaudeBin(env: EnvLike = process.env): string | null {
  const bin = env.PANTRADER_CLAUDE_BIN;
  if (bin) return fs.existsSync(bin) ? bin : null;
  for (const dir of (env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    const p = path.join(dir, "claude");
    try {
      fs.accessSync(p, fs.constants.X_OK);
      return p;
    } catch {
      // 该目录没有就继续找下一个，探测不允许抛错
    }
  }
  return null;
}

export interface ModeProbes {
  hasCli?: () => boolean;
  hasApiKey?: () => boolean;
}

/**
 * 决定用哪个实现。ADVISOR 环境变量显式指定时优先（用户可在设置页强制，spec §5.1），
 * 否则按 CLI → API → Null 的顺序探测宿主能力。
 * ADVISOR=null 必须能把 Claude 彻底关掉，这就是 CI 断言 1 的开关。
 */
export function resolveAdvisorMode(
  env: EnvLike = process.env,
  probes: ModeProbes = {},
): AdvisorMode {
  if (isAdvisorMode(env.ADVISOR)) return env.ADVISOR;

  const hasCli = probes.hasCli ?? (() => findClaudeBin(env) !== null);
  const hasApiKey = probes.hasApiKey ?? (() => Boolean(env.ANTHROPIC_API_KEY?.trim()));

  if (hasCli()) return "claude-cli";
  if (hasApiKey()) return "claude-api";
  return "null";
}

export interface CreateAdvisorOptions {
  env?: EnvLike;
  probes?: ModeProbes;
  cli?: ClaudeCliOptions;
  api?: ClaudeApiOptions;
}

export function createAdvisor(mode?: AdvisorMode, opts: CreateAdvisorOptions = {}): Advisor {
  const env = opts.env ?? process.env;
  const resolved = mode ?? resolveAdvisorMode(env, opts.probes);
  switch (resolved) {
    case "claude-cli":
      return createClaudeCliAdvisor({ bin: findClaudeBin(env) ?? "claude", ...opts.cli });
    case "claude-api":
      return createClaudeApiAdvisor({ env, ...opts.api });
    case "null":
      return createNullAdvisor();
    default:
      // 配置里写了不认识的模式：回落 Null 而不是抛错。
      // 一个拼错的环境变量不该让整套盘前例程起不来。
      return createNullAdvisor();
  }
}

export * from "@/lib/advisor/availability";

import { probeAvailability, type AvailabilityReport } from "@/lib/advisor/availability";
import { nodeSpawn } from "@/lib/advisor/claude-cli";

export interface ResolvedAdvisor {
  advisor: Advisor;
  availability: AvailabilityReport;
}

/**
 * 带可用性判定的解析。异步，因为要真去问一次 `claude auth status`。
 *
 * 与 createAdvisor 的分工：createAdvisor 只按模式给实现（同步、廉价，给已知模式的调用方用）；
 * 这里多做一步登录态判定，给需要**提示用户**的入口用（设置页、盘前例程）。
 *
 * 三态的处理差别是这个函数存在的全部理由：
 *   absent      → NullAdvisor，静默。没装 claude 是正常配置（D2），不该弹提示。
 *   needs-login → 同样回落 NullAdvisor 保证功能完整，**但把可操作提示带出去**。
 *                 装了没登录却静默降级，等于把一条命令能解决的问题藏起来。
 *   ready       → 真实现。
 *
 * ADVISOR 环境变量显式指定时不做探测：用户强制 null 就得是彻底关掉（CI 断言 1），
 * 强制 claude-api 走的是 API key，跟 CLI 登录态无关。
 */
export async function resolveAdvisor(
  opts: CreateAdvisorOptions & { spawn?: typeof nodeSpawn } = {}
): Promise<ResolvedAdvisor> {
  const env = opts.env ?? process.env;

  if (isAdvisorMode(env.ADVISOR)) {
    return {
      advisor: createAdvisor(env.ADVISOR, opts),
      availability: {
        state: env.ADVISOR === "null" ? "absent" : "ready",
        message: `ADVISOR=${env.ADVISOR}（由环境变量显式指定，跳过探测）`,
      },
    };
  }

  const bin = findClaudeBin(env);
  if (!bin) {
    // 没有 CLI 但有 API key 时仍可用 API 路径
    if (env.ANTHROPIC_API_KEY?.trim()) {
      return {
        advisor: createAdvisor("claude-api", opts),
        availability: {
          state: "ready", authMethod: "apiKey",
          message: "Advisor 走 ANTHROPIC_API_KEY（按 token 计费）",
        },
      };
    }
    return {
      advisor: createNullAdvisor(),
      availability: {
        state: "absent",
        message: "未检测到 claude，Advisor 关闭，系统按传统量化流程运行（手动定策略 + 回测优化）",
      },
    };
  }

  const availability = await probeAvailability({
    spawn: opts.spawn ?? nodeSpawn, bin,
  });

  return {
    advisor: availability.state === "ready"
      ? createAdvisor("claude-cli", opts)
      : createNullAdvisor(),
    availability,
  };
}
