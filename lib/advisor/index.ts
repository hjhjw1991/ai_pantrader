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
