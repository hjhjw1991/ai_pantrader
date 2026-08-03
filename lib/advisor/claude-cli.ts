import { spawn as nodeSpawnProcess } from "node:child_process";
import type { Advisor, AdvisorInput, AdvisorSnapshot } from "@/lib/contracts/advisor";
import { validateSlots } from "@/lib/advisor/slots";
import { SLOT_JSON_SCHEMA, buildPrompt } from "@/lib/advisor/prompt";
import { degradedSnapshot, filledSnapshot } from "@/lib/advisor/snapshot";
import { firstJsonObject } from "@/lib/advisor/json";

/**
 * ClaudeCliAdvisor —— 探测到 `claude` CLI 时走子进程（spec §5.1）。
 *
 * 三条铁律，全部因为它挂在交易主流程上：
 *   1. 二进制不存在不抛错，只降级。宿主没装 Claude 是正常配置。
 *   2. 硬超时。模型卡死不能把盘前/盘中例程一起拖死。
 *   3. 解析失败也降级。CLI 的 stdout 是外部输入，永远不能信。
 * advise() 因此整体包在 try/catch 里 —— 契约写明"永不抛错"。
 *
 * spawn 可注入：测试绝不能真去调本机的 claude（慢、要钱、结果不确定）。
 */

export interface SpawnResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** 起进程本身就失败（ENOENT 等）。注意这不是异常，是返回值 —— 调用方不必 try */
  spawnError?: string;
}

export type SpawnFn = (
  cmd: string,
  args: string[],
  opts: { stdin?: string; timeoutMs: number },
) => Promise<SpawnResult>;

export interface ClaudeCliOptions {
  bin?: string;
  model?: string;
  timeoutMs?: number;
  probeTimeoutMs?: number;
  spawn?: SpawnFn;
}

/** 两条通道用同一个模型标识，A/B 时才好把样本对齐 */
export const CLI_DEFAULT_MODEL = "claude-opus-5";
export const CLI_DEFAULT_TIMEOUT_MS = 60_000;
export const CLI_PROBE_TIMEOUT_MS = 5_000;

/**
 * 顾问只需要判断，不需要动这台机器上的任何东西。禁掉全部工具：
 * 万一提示词被行情文本注入，也没有可用的手去改仓位配置或代码。
 */
const DISALLOWED_TOOLS = "Bash Edit Write Read Glob Grep WebFetch WebSearch Task NotebookEdit";

/** 真实 spawn：提示词走 stdin（避开参数长度与引号转义），超时先 TERM 再 KILL */
export const nodeSpawn: SpawnFn = (cmd, args, opts) =>
  new Promise<SpawnResult>(resolve => {
    let child: ReturnType<typeof nodeSpawnProcess>;
    try {
      child = nodeSpawnProcess(cmd, args, { stdio: ["pipe", "pipe", "pipe"] });
    } catch (e: any) {
      resolve({ code: null, stdout: "", stderr: "", timedOut: false, spawnError: String(e?.message ?? e) });
      return;
    }

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const done = (r: SpawnResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      // TERM 之后仍不退的进程要强杀，否则句柄泄漏、下一次调度还在跑
      setTimeout(() => child.kill("SIGKILL"), 2_000).unref?.();
      done({ code: null, stdout, stderr, timedOut: true });
    }, opts.timeoutMs);

    child.stdout?.on("data", d => (stdout += d.toString()));
    child.stderr?.on("data", d => (stderr += d.toString()));
    child.on("error", e => done({ code: null, stdout, stderr, timedOut, spawnError: String(e?.message ?? e) }));
    child.on("close", code => done({ code, stdout, stderr, timedOut }));

    if (opts.stdin !== undefined) {
      child.stdin?.on("error", () => {});
      child.stdin?.end(opts.stdin);
    } else {
      child.stdin?.end();
    }
  });

export function cliArgs(model: string): string[] {
  // 实测本机 claude 2.1.220 的 flag（`claude --help`）：
  //   -p / --print                非交互
  //   --output-format json        单个 JSON 结果对象
  //   --json-schema <schema>      结构化输出约束
  //   --model <alias|full-id>
  //   --no-session-persistence    顾问调用是一次性的，别在本机堆会话
  //   --disallowedTools           禁掉全部工具（见上）
  // 刻意不用 --bare：它把认证限死成 ANTHROPIC_API_KEY / apiKeyHelper，
  // 而 CLI 通道的意义恰恰是复用宿主已登录的凭据，加了 --bare 这条路就断了。
  return [
    "-p",
    "--output-format",
    "json",
    "--json-schema",
    JSON.stringify(SLOT_JSON_SCHEMA),
    "--model",
    model,
    "--no-session-persistence",
    "--disallowedTools",
    DISALLOWED_TOOLS,
  ];
}

/**
 * 解析 CLI stdout。`--output-format json` 的外层是
 * { type:"result", is_error, result: <string|object>, ... }，
 * result 里才是我们要的载荷；也允许模型直接给裸对象。任何一步失败返回 null。
 */
export function parseCliJson(stdout: string): unknown | null {
  const outer = firstJsonObject(stdout);
  if (outer === null || typeof outer !== "object") return null;
  const o = outer as Record<string, unknown>;

  if (o.is_error === true) return null;
  if (o.subtype !== undefined && o.subtype !== "success" && o.result === undefined) return null;

  if (o.result !== undefined) {
    if (typeof o.result === "string") return firstJsonObject(o.result);
    if (typeof o.result === "object" && o.result !== null) return o.result;
    return null;
  }
  // 裸对象：至少得看起来像槽位载荷，否则算不可解析
  return o.slots !== undefined || o.gearOverride !== undefined || o.scoreAdjust !== undefined ? o : null;
}

export function createClaudeCliAdvisor(opts: ClaudeCliOptions = {}): Advisor & {
  available(): Promise<boolean>;
} {
  const bin = opts.bin ?? "claude";
  const model = opts.model ?? CLI_DEFAULT_MODEL;
  const timeoutMs = opts.timeoutMs ?? CLI_DEFAULT_TIMEOUT_MS;
  const probeTimeoutMs = opts.probeTimeoutMs ?? CLI_PROBE_TIMEOUT_MS;
  const spawn = opts.spawn ?? nodeSpawn;

  // 探测结果缓存：每次盘中扫描都 spawn 一次 --version 是白烧几十毫秒
  let probed: Promise<boolean> | null = null;

  async function probe(): Promise<boolean> {
    try {
      const r = await spawn(bin, ["--version"], { timeoutMs: probeTimeoutMs });
      return !r.spawnError && !r.timedOut && r.code === 0;
    } catch {
      return false; // 探测本身不允许把异常放出去
    }
  }

  function available(): Promise<boolean> {
    if (!probed) probed = probe();
    return probed;
  }

  return {
    mode: "claude-cli" as const,
    available,

    async advise(input: AdvisorInput): Promise<AdvisorSnapshot> {
      const degraded = () => degradedSnapshot("claude-cli", input, model);
      try {
        if (!(await available())) return degraded();

        const res = await spawn(bin, cliArgs(model), {
          stdin: buildPrompt(input),
          timeoutMs,
        });
        if (res.spawnError || res.timedOut || res.code !== 0) return degraded();

        const payload = parseCliJson(res.stdout);
        if (payload === null) return degraded();

        const p = payload as Record<string, unknown>;
        const raw = p.slots !== undefined ? p.slots : p;
        const validated = validateSlots(raw, { knownCodes: input.candidates.map(c => c.code) });
        return filledSnapshot("claude-cli", input, model, validated, p.confidence);
      } catch {
        // 兜底：契约要求 advise() 永不 reject，主流程不能因为顾问挂了而中断
        return degraded();
      }
    },
  };
}
