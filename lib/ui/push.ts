import http from "node:http";
import https from "node:https";
import tls from "node:tls";
import { createHmac } from "node:crypto";
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
  /** 飞书群「自定义机器人」webhook，多个用逗号分隔 */
  feishuUrls: string[];
  /** 飞书机器人的签名密钥（可选）。与 feishuUrls 按序配对；只给一个则应用到全部 */
  feishuSecrets: string[];
  /** 飞书机器人若开了「自定义关键词」校验，消息正文必须含它，否则会被拒 */
  feishuKeyword: string | null;
  /** card = 消息卡片（带级别配色）；text = 纯文本，最稳但朴素 */
  feishuStyle: "card" | "text";
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
  const style = (env.PANTRADER_PUSH_FEISHU_STYLE ?? "card").trim().toLowerCase();
  return {
    wecomUrls: splitList(env.PANTRADER_PUSH_WECOM),
    feishuUrls: splitList(env.PANTRADER_PUSH_FEISHU),
    feishuSecrets: splitList(env.PANTRADER_PUSH_FEISHU_SECRET),
    feishuKeyword: env.PANTRADER_PUSH_FEISHU_KEYWORD?.trim() || null,
    feishuStyle: style === "text" ? "text" as const : "card" as const,
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
  return cfg.wecomUrls.length > 0 || cfg.feishuUrls.length > 0 || !!cfg.barkUrl || cfg.genericUrls.length > 0;
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

/* ------------------------------------------------------------------ *
 * 飞书：群里的「自定义机器人」。
 *
 * 为什么它值得单独支持，而不是继续用通用 webhook：
 *   - 零门槛：不用实名、不用营业执照、不用注册开放平台应用，
 *     普通飞书账号在桌面客户端里建个群就能拿到 webhook（见 push-test.ts 的提示）。
 *   - 网络最省心：open.feishu.cn 本机**直连可达**，
 *     不像 PushPlus / Bark / Server酱 必须绕本机代理（代理一挂推送就断）。
 *   - 落点是真正的 IM 原生推送：手机飞书 App 秒到、锁屏可见。
 *     这点是微信公众号类方案给不了的 —— 服务号消息在 iOS 上通常不弹通知。
 *
 * 三个坑：
 *   1. 成功与否同样写在 body 里（"code":0），只看 HTTP 状态码会误判。
 *   2. 若机器人开了「自定义关键词」，正文不含关键词会被拒且原因难懂，
 *      所以支持 PANTRADER_PUSH_FEISHU_KEYWORD，把它固定拼进页脚。
 *   3. 开了「签名校验」则要按 HMAC-SHA256 签名，**密钥是 `${ts}\n${secret}`、
 *      被签内容为空串** —— 两边搞反的话签名永远不匹配。
 * ------------------------------------------------------------------ */

/** 飞书加签：HMAC-SHA256(key = `${秒级时间戳}\n${密钥}`, msg = "")，结果 base64。 */
export function feishuSign(secret: string, tsSec: number): string {
  return createHmac("sha256", `${tsSec}\n${secret}`).update("").digest("base64");
}

const FEISHU_LEVEL_TAG: Record<PushSeverity, string> = {
  critical: "**紧急**", warn: "提示", info: "信息",
};
/** 消息卡片表头配色：critical 红、warn 橙、info 蓝。 */
const FEISHU_TEMPLATE: Record<PushSeverity, string> = {
  critical: "red", warn: "orange", info: "blue",
};

/** 纯文本形态的正文。 */
export function feishuText(m: PushMessage, keyword?: string | null): string {
  const head = `${m.title}\n${FEISHU_LEVEL_TAG[m.severity]}｜${m.kind}｜${m.ts}`;
  const tail = keyword ? `候潮 · ${keyword}` : "候潮";
  return `${head}${m.body ? `\n\n${m.body}` : ""}\n\n${tail}`;
}

/** 卡片正文（lark_md）：级别标签 + 类型 + 时间，再接一条分割线。 */
export function feishuCardContent(m: PushMessage): string {
  return `${FEISHU_LEVEL_TAG[m.severity]}｜${m.kind}｜${m.ts}${m.body ? `\n\n${m.body}` : ""}`;
}

export interface FeishuPayloadOpts {
  keyword?: string | null;
  style?: "card" | "text";
  /** 秒级时间戳，用于加签。不传表示不加签 */
  tsSec?: number;
  secret?: string | null;
}

/**
 * 组装飞书请求体。导出是为了能在测试里直接断言结构 ——
 * 卡片的 schema 一旦写错，线上表现是"HTTP 200 但手机没反应"，很难查。
 */
export function feishuPayload(m: PushMessage, opts: FeishuPayloadOpts = {}): Record<string, unknown> {
  const kw = opts.keyword ?? null;
  const tail = kw ? `候潮 · ${kw}` : "候潮";

  const payload: Record<string, unknown> = (opts.style ?? "card") === "text"
    ? { msg_type: "text", content: { text: feishuText(m, kw) } }
    : {
      msg_type: "interactive",
      card: {
        config: { wide_screen_mode: true },
        // header.content 不接受换行，标题里的回车会直接让整条被拒
        header: {
          template: FEISHU_TEMPLATE[m.severity],
          title: { tag: "plain_text", content: m.title.replace(/\s*\n\s*/g, " ").trim() },
        },
        elements: [
          { tag: "div", text: { tag: "lark_md", content: feishuCardContent(m) } },
          { tag: "hr" },
          { tag: "note", elements: [{ tag: "plain_text", content: tail }] },
        ],
      },
    };

  if (opts.secret && opts.tsSec !== undefined) {
    payload.timestamp = String(opts.tsSec);
    payload.sign = feishuSign(opts.secret, opts.tsSec);
  }
  return payload;
}

/** secrets 与 urls 的配对：不配 -> 全不加签；配一个 -> 应用到全部；多个 -> 按顺序。 */
export function secretFor(index: number, urls: string[], secrets: string[]): string | null {
  if (secrets.length === 0) return null;
  if (secrets.length === 1) return secrets[0];
  return secrets[index] ?? secrets[secrets.length - 1] ?? null;
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

/**
 * 走代理发一次；**网络层**失败就直连重试一次。
 *
 * 为什么需要它：本机的代理端口会漂移（实测一周内 63722 → 52420），
 * 而飞书和企业微信本来就是**直连可达**的。代理一挂，推送就静默失效——
 * 这恰恰是最坏的结果，因为"没收到"本身不产生任何信号。
 *
 * 只在拿到响应之前失败才重试：一旦收到响应（哪怕是 200 但业务错误码），
 * 说明链路是通的，重发只会让用户收到两条一样的消息。
 */
async function requestWithFallback(
  url: string, opts: ReqOpts, cfg: PushConfig, io: Transport
): Promise<{ status: number; body: string }> {
  try {
    return await io(url, opts, { proxy: cfg.proxy, timeoutMs: cfg.timeoutMs });
  } catch (e) {
    if (!cfg.proxy) throw e;
    return await io(url, opts, { proxy: null, timeoutMs: cfg.timeoutMs });
  }
}

async function sendWecom(url: string, m: PushMessage, cfg: PushConfig, io: Transport): Promise<SendResult> {
  try {
    const res = await requestWithFallback(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ msgtype: "markdown", markdown: { content: wecomContent(m) } }),
    }, cfg, io);
    // 企业微信的业务错误也返回 200，必须看 body 里的 errcode
    const errcode = /"errcode"\s*:\s*(\d+)/.exec(res.body)?.[1];
    return { target: "wecom", ok: res.status === 200 && errcode === "0", status: res.status,
      ...(errcode && errcode !== "0" ? { error: `errcode=${errcode} ${res.body.slice(0, 120)}` } : {}) };
  } catch (e) {
    return { target: "wecom", ok: false, error: String((e as Error)?.message ?? e) };
  }
}

/**
 * 飞书的业务错误也是 HTTP 200，必须读 body 里的 code。
 * 老版本返回的是 StatusCode，两个都认；取不到 code 时退回按状态码判。
 */
async function sendFeishu(url: string, m: PushMessage, cfg: PushConfig, io: Transport, secret?: string | null): Promise<SendResult> {
  try {
    const tsSec = secret ? Math.floor(Date.now() / 1000) : undefined;
    const res = await requestWithFallback(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(feishuPayload(m, {
        keyword: cfg.feishuKeyword, style: cfg.feishuStyle, tsSec, secret,
      })),
    }, cfg, io);

    const code = /"(?:code|StatusCode)"\s*:\s*(-?\d+)/.exec(res.body)?.[1];
    const httpOk = res.status >= 200 && res.status < 300;
    const ok = httpOk && (code === undefined || code === "0");
    return {
      target: "feishu", ok, status: res.status,
      ...(ok || code === undefined ? {} : { error: `code=${code} ${res.body.slice(0, 120)}` }),
      ...(!httpOk ? { error: res.body.slice(0, 120) } : {}),
    };
  } catch (e) {
    return { target: "feishu", ok: false, error: String((e as Error)?.message ?? e) };
  }
}

async function sendBark(base: string, m: PushMessage, cfg: PushConfig, io: Transport): Promise<SendResult> {
  try {
    // Bark 的 REST 形态：/<key>/<标题>/<正文>；路径段要编码，正文里的换行会截断 URL
    const title = encodeURIComponent(m.title.replace(/\n/g, " "));
    const body = encodeURIComponent((m.body ?? "").replace(/\n/g, " "));
    const level = m.severity === "critical" ? "critical" : m.severity === "warn" ? "active" : "active";
    const url = `${base}/${title}/${body}?level=${level}&group=候潮`;
    const res = await requestWithFallback(url, { method: "GET", headers: {} }, cfg, io);
    return { target: "bark", ok: res.status === 200, status: res.status,
      ...(res.status === 200 ? {} : { error: res.body.slice(0, 120) }) };
  } catch (e) {
    return { target: "bark", ok: false, error: String((e as Error)?.message ?? e) };
  }
}

async function sendGeneric(url: string, m: PushMessage, cfg: PushConfig, io: Transport): Promise<SendResult> {
  try {
    const res = await requestWithFallback(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: m.title, body: m.body ?? "", severity: m.severity, kind: m.kind, ts: m.ts }),
    }, cfg, io);
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
  cfg.feishuUrls.forEach((u, i) => jobs.push(sendFeishu(u, m, cfg, io, secretFor(i, cfg.feishuUrls, cfg.feishuSecrets))));
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
    /**
     * 带上日志。dispatchPush 默认的 log 是空函数，那样一旦推送失败，
     * 守护进程日志里**什么都不留**——手机一直收不到时没有任何线索可查。
     * 走 stderr，采集守护进程的日志会一并收走。
     */
    void dispatchPush(m, { config: cfg, log: (line) => console.warn(line) }).catch(() => {});
  } catch {
    // 推送是增强：这里的任何异常都不该冒到调用方的采集/交易流程上
  }
}
