import http from "node:http";
import https from "node:https";
import tls from "node:tls";
import type { Duplex } from "node:stream";

/**
 * 通知的对外推送（手机侧）。
 *
 * 为什么必须存在：网页通知只在浏览器开着时有用。通知的意义恰恰是
 * **人没盯着屏幕的时候还能收到**，所以外发只能挂在守护进程里，不能挂在前端。
 *
 * 三条纪律：
 *   1. 静默失败 —— 推送是增强，网络挂了绝不能让"写通知"这件事失败，
 *      更不能影响旁边的采集与交易逻辑。所有异常都在本文件里咽掉。
 *   2. 不阻塞   —— 调用方不等网络。`pushOutbound` 返回即返回，内部自己跑。
 *   3. 不刷屏   —— 沿用 notify.ts 的口径，默认只发 warn/critical（"要求人做动作的才响"），
 *      并做同类节流。弹多了，critical 会跟着一起被无视。
 */

export type PushSeverity = "critical" | "warn" | "info";

export interface PushMessage {
  kind: string;
  severity: PushSeverity;
  title: string;
  body?: string | null;
  ts: string;
}

export interface PushConfig {
  /** 企业微信群机器人 webhook，多个用逗号分隔 */
  wecomUrls: string[];
  /** Bark key（走官方服务器）或完整推送 URL */
  barkUrl: string | null;
  /** 通用 webhook：POST application/json */
  genericUrls: string[];
  /** 只发这个级别及以上，默认 warn */
  minSeverity: PushSeverity;
  /** 同类消息节流秒数，默认 300 */
  throttleSec: number;
  /** 可选代理，形如 http://127.0.0.1:7890 */
  proxy: string | null;
  timeoutMs: number;
}

const SEVERITY_RANK: Record<PushSeverity, number> = { critical: 2, warn: 1, info: 0 };

function splitList(v: string | undefined): string[] {
  return (v ?? "").split(",").map(s => s.trim()).filter(Boolean);
}

export function readPushConfig(env: Partial<NodeJS.ProcessEnv> = process.env): PushConfig {
  const rawBark = env.PANTRADER_PUSH_BARK?.trim();
  const min = (env.PANTRADER_PUSH_MIN_SEVERITY ?? "warn").trim() as PushSeverity;
  return {
    wecomUrls: splitList(env.PANTRADER_PUSH_WECOM),
    barkUrl: rawBark
      ? (/^https?:\/\//.test(rawBark) ? rawBark : `https://api.day.app/${rawBark}`)
      : null,
    genericUrls: splitList(env.PANTRADER_PUSH_URL),
    minSeverity: min in SEVERITY_RANK ? min : "warn",
    throttleSec: Number(env.PANTRADER_PUSH_THROTTLE_SEC ?? 300),
    proxy: env.HTTPS_PROXY ?? env.https_proxy ?? env.HTTP_PROXY ?? env.http_proxy ?? null,
    timeoutMs: Number(env.PANTRADER_PUSH_TIMEOUT_MS ?? 8000),
  };
}

export function isEnabled(cfg: PushConfig): boolean {
  return cfg.wecomUrls.length > 0 || !!cfg.barkUrl || cfg.genericUrls.length > 0;
}

export function shouldPush(cfg: PushConfig, m: PushMessage): boolean {
  const got = SEVERITY_RANK[m.severity] ?? 0;
  const need = SEVERITY_RANK[cfg.minSeverity] ?? 1;
  return got >= need;
}

/** 企业微信机器人的 markdown 正文。签名：标题加粗 + 级别标签 + 正文。 */
export function wecomContent(m: PushMessage): string {
  const tag = m.severity === "critical" ? "<font color=\"warning\">紧急</font>"
    : m.severity === "warn" ? "<font color=\"comment\">提示</font>" : "信息";
  const head = `**${m.title}**\n> ${tag}｜${m.kind}｜${m.ts}`;
  return m.body ? `${head}\n\n${m.body}` : head;
}

export interface SendResult {
  target: string;
  ok: boolean;
  status?: number;
  error?: string;
}

interface ReqOpts { method: string; headers: Record<string, string>; body?: string }

/** 通过 HTTP CONNECT 隧道建立到目标的 TCP 连接。代理不支持 CONNECT 时会 reject。 */
function connectViaProxy(proxyUrl: string, host: string, port: number, timeoutMs: number): Promise<Duplex> {
  return new Promise((resolve, reject) => {
    const p = new URL(proxyUrl);
    const req = http.request({
      host: p.hostname,
      port: Number(p.port || 80),
      method: "CONNECT",
      path: `${host}:${port}`,
      headers: { Host: `${host}:${port}` },
      timeout: timeoutMs,
    });
    req.once("connect", (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        reject(new Error(`代理 CONNECT 返回 ${res.statusCode}`));
        return;
      }
      resolve(socket);
    });
    req.once("error", reject);
    req.once("timeout", () => { req.destroy(new Error("代理连接超时")); });
    req.end();
  });
}

/**
 * 发一个 HTTPS 请求。
 *
 * 为什么自己写而不用 fetch：Node 内置的 fetch 不读 HTTPS_PROXY，而本机上
 * PushPlus / Bark / Server酱 **必须走代理才可达**（直连 31s 超时）。
 * 走代理时先用 CONNECT 打通隧道，再在隧道上做 TLS —— 这样目标仍是 https，
 * 不会因为走代理就降级成明文。
 */
export function requestHttps(
  urlStr: string,
  opts: ReqOpts,
  deps: { proxy?: string | null; timeoutMs?: number } = {},
  _io?: Transport
): Promise<{ status: number; body: string }> {
  const timeoutMs = deps.timeoutMs ?? 8000;
  return new Promise((resolve, reject) => {
    let settled = false;
    let req: http.ClientRequest | undefined;

    /**
     * 只有真正落地（成功 / 出错 / 超时）才清定时器。
     *
     * 上一版写成 `try { ... } finally { clearTimeout(timer) }`，看着对称其实致命：
     * 不用代理时 executor 同步跑到 finally，定时器**在请求刚发出就被清掉**，
     * 于是"超时"这条保护形同虚设 —— 目标不可达时会一直挂着，
     * 守护进程里就会堆一堆永不返回的推送请求。
     */
    const settle = (err: Error | null, val?: { status: number; body: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) {
        try { req?.destroy(); } catch { /* 已经关了就算了 */ }
        reject(err);
      } else {
        resolve(val!);
      }
    };
    const timer = setTimeout(() => settle(new Error("推送请求超时")), timeoutMs);

    void (async () => {
      try {
        const u = new URL(urlStr);
        const port = Number(u.port || 443);
        let createConnection: (() => Duplex) | undefined;
        if (deps.proxy) {
          const raw = await connectViaProxy(deps.proxy, u.hostname, port, timeoutMs);
          createConnection = () => tls.connect({ socket: raw as any, servername: u.hostname });
        }
        req = https.request({
          host: u.hostname, port, path: `${u.pathname}${u.search}`,
          method: opts.method, headers: opts.headers,
          agent: false, timeout: timeoutMs,
          ...(createConnection ? { createConnection } : {}),
        }, res => {
          let body = "";
          res.setEncoding("utf8");
          res.on("data", c => { body += c; });
          res.on("end", () => settle(null, { status: res.statusCode ?? 0, body }));
        });
        req.once("timeout", () => settle(new Error("推送请求超时")));
        req.once("error", (e) => settle(e as Error));
        if (opts.body) req.write(opts.body);
        req.end();
      } catch (e) {
        settle(e as Error);
      }
    })();
  });
}

export type Transport = (
  url: string,
  opts: ReqOpts,
  deps: { proxy?: string | null; timeoutMs?: number }
) => Promise<{ status: number; body: string }>;

async function sendWecom(url: string, m: PushMessage, cfg: PushConfig, io: Transport): Promise<SendResult> {
  try {
    const res = await io(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ msgtype: "markdown", markdown: { content: wecomContent(m) } }),
    }, { proxy: cfg.proxy, timeoutMs: cfg.timeoutMs });
    // 企业微信的业务错误也返回 200，必须看 body 里的 errcode
    const errcode = /"errcode"\s*:\s*(\d+)/.exec(res.body)?.[1];
    return { target: "wecom", ok: res.status === 200 && errcode === "0", status: res.status,
      ...(errcode && errcode !== "0" ? { error: `errcode=${errcode} ${res.body.slice(0, 120)}` } : {}) };
  } catch (e) {
    return { target: "wecom", ok: false, error: String((e as Error)?.message ?? e) };
  }
}

async function sendBark(base: string, m: PushMessage, cfg: PushConfig, io: Transport): Promise<SendResult> {
  try {
    // Bark 的 REST 形态：/<key>/<标题>/<正文>；路径段要编码，正文里的换行会截断 URL
    const title = encodeURIComponent(m.title.replace(/\n/g, " "));
    const body = encodeURIComponent((m.body ?? "").replace(/\n/g, " "));
    const level = m.severity === "critical" ? "critical" : m.severity === "warn" ? "active" : "active";
    const url = `${base}/${title}/${body}?level=${level}&group=候潮`;
    const res = await io(url, { method: "GET", headers: {} },
      { proxy: cfg.proxy, timeoutMs: cfg.timeoutMs });
    return { target: "bark", ok: res.status === 200, status: res.status,
      ...(res.status === 200 ? {} : { error: res.body.slice(0, 120) }) };
  } catch (e) {
    return { target: "bark", ok: false, error: String((e as Error)?.message ?? e) };
  }
}

async function sendGeneric(url: string, m: PushMessage, cfg: PushConfig, io: Transport): Promise<SendResult> {
  try {
    const res = await io(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: m.title, body: m.body ?? "", severity: m.severity, kind: m.kind, ts: m.ts }),
    }, { proxy: cfg.proxy, timeoutMs: cfg.timeoutMs });
    return { target: "webhook", ok: res.status >= 200 && res.status < 300, status: res.status };
  } catch (e) {
    return { target: "webhook", ok: false, error: String((e as Error)?.message ?? e) };
  }
}

/** 进程内节流：同一个 dedupeKey（没有就用 kind）在窗口内只发一次。 */
const lastSent = new Map<string, number>();

export function throttled(key: string, now: number, windowSec: number): boolean {
  const prev = lastSent.get(key);
  const win = Number.isFinite(windowSec) && windowSec > 0 ? windowSec * 1000 : 300_000;
  if (prev !== undefined && now - prev < win) return true;
  lastSent.set(key, now);
  return false;
}

/** 测试用：清掉节流记忆 */
export function resetThrottle(): void {
  lastSent.clear();
}

export async function dispatchPush(
  m: PushMessage,
  deps: {
    config?: PushConfig; now?: () => number; key?: string;
    log?: (line: string) => void; io?: Transport;
  } = {}
): Promise<SendResult[]> {
  const cfg = deps.config ?? readPushConfig();
  const io = deps.io ?? requestHttps;
  const log = deps.log ?? (() => {});
  const results: SendResult[] = [];
  if (!isEnabled(cfg)) return results;
  if (!shouldPush(cfg, m)) return results;

  const key = deps.key ?? `${m.kind}:${m.title}`;
  if (throttled(key, (deps.now ?? Date.now)(), cfg.throttleSec)) {
    log(`[候潮] 推送节流跳过：${key}`);
    return results;
  }

  const jobs: Promise<SendResult>[] = [];
  for (const u of cfg.wecomUrls) jobs.push(sendWecom(u, m, cfg, io));
  if (cfg.barkUrl) jobs.push(sendBark(cfg.barkUrl, m, cfg, io));
  for (const u of cfg.genericUrls) jobs.push(sendGeneric(u, m, cfg, io));

  const out = await Promise.all(jobs);
  for (const r of out) {
    results.push(r);
    if (!r.ok) log(`[候潮] 推送失败 ${r.target}: ${r.error ?? r.status}`);
  }
  return results;
}

/**
 * 入口：写完库里的通知之后调一下。不返回 Promise，外部也不需要 await ——
 * 网络结果落在守护进程日志里。任何异常都在内部消化。
 */
export function pushOutbound(m: PushMessage): void {
  try {
    const cfg = readPushConfig();
    if (!isEnabled(cfg)) return;   // 没配 = 没启用，连一次网络都不发
    void dispatchPush(m, { config: cfg }).catch(() => {});
  } catch {
    // 推送是增强：这里的任何异常都不该冒到调用方的采集/交易流程上
  }
}
