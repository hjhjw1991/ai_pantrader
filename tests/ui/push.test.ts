import { createHmac } from "node:crypto";
import http from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { beforeEach, describe, expect, it } from "vitest";
import {
  dispatchPush, feishuAtTag, feishuCardContent, feishuPayload, feishuSign, feishuText, isEnabled,
  flushPushes, isPreSendError, pendingPushes, pushOutbound, PushPreSendError, readPushConfig,
  requestHttps, resetThrottle, secretFor, shouldPush, throttled, trackPush, wecomContent,
} from "@/lib/ui/push";
import type { PushConfig, PushMessage, Transport } from "@/lib/ui/push";

/**
 * 手机侧推送。
 *
 * 这里盯的三件事，都是踩过才知道痛的：
 *   1. 没配通道时必须**一次网络都不发** —— 否则单测、回放、别人的机器都在偷偷联网。
 *   2. 任何网络错误都不能冒出去 —— 推送失败让"写通知"失败，是本末倒置。
 *   3. 企业级 webhook 用 200 + body.errcode 表示业务错误，只看状态码会把
 *      key 写错当成成功，从此静默失效。
 */

function cfg(patch: Partial<PushConfig> = {}): PushConfig {
  return {
    wecomUrls: [], feishuUrls: [], feishuSecrets: [], feishuKeyword: null, feishuStyle: "card",
    feishuAt: null, feishuAtName: null,
    barkUrl: null, genericUrls: [],
    minSeverity: "warn", throttleSec: 300, proxy: null, timeoutMs: 8000,
    ...patch,
  };
}

const msg = (patch: Partial<PushMessage> = {}): PushMessage => ({
  kind: "hard_line", severity: "critical", title: "硬线告警 2 条",
  body: "持仓触及止损", ts: "2026-09-30 14:55:00",
  ...patch,
});

/** 假通道：记录每个请求，按需返回状态码与 body */
function recorder(status = 200, body = '{"errcode":0,"errmsg":"ok"}') {
  const calls: Array<{ url: string; payload: string }> = [];
  const io: Transport = async (url, opts) => {
    calls.push({ url, payload: opts.body ?? "" });
    return { status, body };
  };
  return { calls, io };
}

beforeEach(() => {
  resetThrottle();
});

describe("readPushConfig", () => {
  it("没有任何推送变量时判定为未启用", () => {
    const c = readPushConfig({});
    expect(isEnabled(c)).toBe(false);
  });

  it("默认门槛是 warn（info 不占用通知额度）", () => {
    expect(readPushConfig({}).minSeverity).toBe("warn");
  });

  it("企业微信多个 webhook 用逗号分隔", () => {
    const c = readPushConfig({ PANTRADER_PUSH_WECOM: "https://a/x, https://b/y" });
    expect(c.wecomUrls).toEqual(["https://a/x", "https://b/y"]);
  });

  it("Bark 只给 key 时自动补官方服务器", () => {
    expect(readPushConfig({ PANTRADER_PUSH_BARK: "AbCd" }).barkUrl)
      .toBe("https://api.day.app/AbCd");
  });

  it("Bark 给完整 URL 时不改写（自建服务器要用）", () => {
    const u = "https://push.example.com/AbCd";
    expect(readPushConfig({ PANTRADER_PUSH_BARK: u }).barkUrl).toBe(u);
  });

  it("代理从 HTTPS_PROXY 读到 https_proxy 混写的两个名字", () => {
    expect(readPushConfig({ HTTPS_PROXY: "http://127.0.0.1:7890" }).proxy)
      .toBe("http://127.0.0.1:7890");
    expect(readPushConfig({ https_proxy: "http://127.0.0.1:7891" }).proxy)
      .toBe("http://127.0.0.1:7891");
  });

  it("门槛值写错（不是三档之一）时退回 warn", () => {
    expect(readPushConfig({ PANTRADER_PUSH_MIN_SEVERITY: "urgent" }).minSeverity).toBe("warn");
  });
});

describe("shouldPush", () => {
  it("默认只放行 warn / critical", () => {
    const c = cfg();
    expect(shouldPush(c, msg({ severity: "info" }))).toBe(false);
    expect(shouldPush(c, msg({ severity: "warn" }))).toBe(true);
    expect(shouldPush(c, msg({ severity: "critical" }))).toBe(true);
  });

  it("门槛提到 critical 时不放 warn", () => {
    expect(shouldPush(cfg({ minSeverity: "critical" }), msg({ severity: "warn" }))).toBe(false);
  });
});

describe("wecomContent", () => {
  it("带上标题、类型、时间戳", () => {
    const s = wecomContent(msg());
    expect(s).toContain("硬线告警 2 条");
    expect(s).toContain("hard_line");
    expect(s).toContain("2026-09-30 14:55:00");
  });

  it("critical 标成紧急，warn 不标", () => {
    expect(wecomContent(msg({ severity: "critical" }))).toContain("紧急");
    expect(wecomContent(msg({ severity: "warn" }))).not.toContain("紧急");
  });

  it("没有正文时不留空行尾巴", () => {
    expect(wecomContent(msg({ body: null })).trimEnd().endsWith("]")).toBe(false);
    expect(wecomContent(msg({ body: null }))).not.toMatch(/\n\n$/);
  });
});

/**
 * 飞书通道。
 *
 * 盯的是"配错之后 HTTP 依然 200"这类会让故障隐形的点：成功看 code、
 * 标题不能带换行（会被整条拒）、关键词校验的关键词得真的出现在正文里。
 */
describe("飞书消息体", () => {
  const FEISHU = "https://open.feishu.cn/open-apis/bot/v2/hook/token-1";

  it("默认发消息卡片，表头按级别配色", () => {
    const p = feishuPayload(msg({ severity: "critical" })) as any;
    expect(p.msg_type).toBe("interactive");
    expect(p.card.header.template).toBe("red");
    expect(p.card.header.title.content).toBe("硬线告警 2 条");
    expect(feishuPayload(msg({ severity: "warn" })).card).toBeTruthy();
    expect((feishuPayload(msg({ severity: "warn" })) as any).card.header.template).toBe("orange");
  });

  it("标题里的换行会被压平——卡片表头不接受回车，否则整条被拒", () => {
    const p = feishuPayload(msg({ title: "硬线告警\n第二行" })) as any;
    expect(p.card.header.title.content).toBe("硬线告警 第二行");
  });

  it("正文带上级别、类型、时间", () => {
    const s = feishuCardContent(msg());
    expect(s).toContain("hard_line");
    expect(s).toContain("2026-09-30 14:55:00");
    expect(s).toContain("持仓触及止损");
  });

  it("style=text 时降级成纯文本，且同样带齐要素", () => {
    const p = feishuPayload(msg(), { style: "text" }) as any;
    expect(p.msg_type).toBe("text");
    expect(p.content.text).toContain("硬线告警 2 条");
    expect(p.content.text).toContain("hard_line");
  });

  it("开了自定义关键词时，关键字真的出现在正文里（否则被静默拒）", () => {
    const card = feishuPayload(msg(), { keyword: "候潮" }) as any;
    expect(JSON.stringify(card)).toContain("候潮");
    expect(feishuText(msg(), "候潮")).toContain("候潮");
  });

  it("加签：同一时间戳+密钥可复现，且与官方文档口径一致", () => {
    // HMAC-SHA256(key = "1690000000\nsecret", msg = "")
    expect(feishuSign("secret", 1_690_000_000)).toBe(
      createHmac("sha256", "1690000000\nsecret").update("").digest("base64"));
    expect(feishuSign("secret", 1_690_000_000)).not.toBe(feishuSign("secret", 1_690_000_001));
  });

  it("配了密钥才加签，没配就不带签名字段", () => {
    expect(feishuPayload(msg(), { tsSec: 1 })).not.toHaveProperty("sign");
    const signed = feishuPayload(msg(), { tsSec: 1, secret: "s" }) as any;
    expect(signed.timestamp).toBe("1");
    expect(signed.sign).toBe(feishuSign("s", 1));
  });

  it("@ 标签：卡片与纯文本是两套语法，不能混用", () => {
    expect(feishuAtTag("all", "card")).toBe("<at id=all></at>");
    // 混用会让整条消息被拒：纯文本里必须是 user_id="all" 带引号
    expect(feishuAtTag("all", "text")).toBe(`<at user_id="all">所有人</at>`);
    expect(feishuAtTag("ou_abc", "card")).toBe("<at id=ou_abc></at>");
  });

  it("不 @ 时正文里不留任何残留标签", () => {
    expect(feishuAtTag(null, "card")).toBe("");
    expect(feishuCardContent(msg(), null)).not.toContain("<at");
    expect(feishuText(msg(), null, null)).not.toContain("<at");
  });

  it("@ 标签放在正文最前面（第一眼看到的是有人在叫你）", () => {
    expect(feishuCardContent(msg(), "all").startsWith("<at id=all></at>\n")).toBe(true);
  });

  it("密钥配对：不配→无；一个→全用；多个→按序", () => {
    const urls = ["a", "b"];
    expect(secretFor(0, urls, [])).toBeNull();
    expect(secretFor(1, urls, ["only"])).toBe("only");
    expect(secretFor(1, urls, ["x", "y"])).toBe("y");
  });
});

describe("飞书发送", () => {
  const FEISHU = "https://open.feishu.cn/open-apis/bot/v2/hook/token-1";

  it("code=0 才算成功", async () => {
    const { calls, io } = recorder(200, '{"code":0,"msg":"success"}');
    const out = await dispatchPush(msg(), { config: cfg({ feishuUrls: [FEISHU] }), io });
    expect(out[0].ok).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it("HTTP 200 但 code 非 0 必须判失败（token 写错不能被当成成功）", async () => {
    const { io } = recorder(200, '{"code":19001,"msg":"param invalid"}');
    const out = await dispatchPush(msg(), { config: cfg({ feishuUrls: [FEISHU] }), io });
    expect(out[0].ok).toBe(false);
    expect(out[0].error).toContain("19001");
  });

  it("老版本返回的 StatusCode 也认", async () => {
    const { io } = recorder(200, '{"StatusCode":0,"StatusMessage":"success"}');
    const out = await dispatchPush(msg(), { config: cfg({ feishuUrls: [FEISHU] }), io });
    expect(out[0].ok).toBe(true);
  });

  it("加签时请求体里带上 timestamp 与 sign", async () => {
    const { calls, io } = recorder();
    await dispatchPush(msg(), { config: cfg({ feishuUrls: [FEISHU], feishuSecrets: ["sec"] }), io });
    const p = JSON.parse(calls[0].payload);
    expect(p.timestamp).toMatch(/^\d{10}$/);
    expect(p.sign).toBe(feishuSign("sec", Number(p.timestamp)));
  });

  it("多个机器人各用自己的密钥", async () => {
    const { calls, io } = recorder();
    await dispatchPush(msg(), {
      config: cfg({ feishuUrls: [FEISHU, `${FEISHU}-2`], feishuSecrets: ["s1", "s2"] }), io,
    });
    const signs = calls.map(c => JSON.parse(c.payload).sign);
    expect(signs[0]).not.toBe(signs[1]);
  });

  it("网络错误不向上抛", async () => {
    const io: Transport = async () => { throw new Error("ETIMEDOUT"); };
    const out = await dispatchPush(msg(), { config: cfg({ feishuUrls: [FEISHU] }), io });
    expect(out[0].ok).toBe(false);
    expect(out[0].error).toContain("ETIMEDOUT");
  });
});

describe("throttled", () => {
  it("窗口内第二次被拦住", () => {
    expect(throttled("k", 1_000, 300)).toBe(false);
    expect(throttled("k", 1_000 + 299_000, 300)).toBe(true);
  });

  it("过了窗口又能发", () => {
    throttled("k", 1_000, 300);
    expect(throttled("k", 1_000 + 301_000, 300)).toBe(false);
  });

  it("不同 key 互不影响", () => {
    throttled("a", 1_000, 300);
    expect(throttled("b", 1_000, 300)).toBe(false);
  });

  it("throttleSec 配成 0 或非法值时不报错，退回默认窗口", () => {
    expect(throttled("k", 1_000, 0)).toBe(false);
    expect(throttled("k", 1_000 + 1000, 0)).toBe(true);
  });
});

describe("dispatchPush", () => {
  it("没配任何通道时一次网络都不发", async () => {
    const { calls, io } = recorder();
    const out = await dispatchPush(msg(), { config: cfg(), io });
    expect(out).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("info 级默认不发", async () => {
    const { calls, io } = recorder();
    await dispatchPush(msg({ severity: "info" }), { config: cfg({ wecomUrls: ["https://a"] }), io });
    expect(calls).toEqual([]);
  });

  it("发到企业微信，并按 body 里的 errcode 判成功", async () => {
    const { calls, io } = recorder(200, '{"errcode":0,"errmsg":"ok"}');
    const out = await dispatchPush(msg(), { config: cfg({ wecomUrls: ["https://a/x"] }), io });
    expect(out).toHaveLength(1);
    expect(out[0].ok).toBe(true);
    expect(calls[0].url).toBe("https://a/x");
    expect(JSON.parse(calls[0].payload).markdown.content).toContain("硬线告警 2 条");
  });

  it("HTTP 200 但 errcode 非 0 时算失败（key 写错不能被当成成功）", async () => {
    const { io } = recorder(200, '{"errcode":93000,"errmsg":"invalid webhook url"}');
    const out = await dispatchPush(msg(), { config: cfg({ wecomUrls: ["https://a/x"] }), io });
    expect(out[0].ok).toBe(false);
    expect(out[0].error).toContain("93000");
  });

  it("网络错误被吞掉变成 SendResult，不向上抛", async () => {
    const io: Transport = async () => { throw new Error("ETIMEDOUT"); };
    const out = await dispatchPush(msg(), { config: cfg({ wecomUrls: ["https://a"] }), io });
    expect(out[0].ok).toBe(false);
    expect(out[0].error).toContain("ETIMEDOUT");
  });

  it("多个通道同时配了就同时发", async () => {
    const { calls, io } = recorder();
    const out = await dispatchPush(msg(), {
      config: cfg({ wecomUrls: ["https://a"], genericUrls: ["https://b"], barkUrl: "https://api.day.app/K" }),
      io,
    });
    expect(out).toHaveLength(3);
    expect(calls.map(c => new URL(c.url).host)).toEqual(["a", "api.day.app", "b"]);
  });

  it("Bark 的标题正文做了 URL 编码，换行不会截断请求", async () => {
    const { calls, io } = recorder();
    await dispatchPush(msg({ body: "第一行\n第二行" }), {
      config: cfg({ barkUrl: "https://api.day.app/K" }), io,
    });
    expect(calls[0].url).not.toContain("\n");
    expect(calls[0].url).toContain(encodeURIComponent("第一行 第二行".slice(1)));
  });

  it("同一条消息短时间内不重复炸出去", async () => {
    const { calls, io } = recorder();
    const c = cfg({ wecomUrls: ["https://a"] });
    await dispatchPush(msg(), { config: c, io, now: () => 1_000 });
    await dispatchPush(msg(), { config: c, io, now: () => 1_500 });
    expect(calls).toHaveLength(1);
  });

  it("失败会写日志，成功不写", async () => {
    const lines: string[] = [];
    const io: Transport = async () => { throw new Error("boom"); };
    await dispatchPush(msg(), { config: cfg({ wecomUrls: ["https://a"] }), io, log: l => lines.push(l) });
    expect(lines.join()).toContain("推送失败");
  });
});

/**
 * 代理失败回退直连。
 *
 * 起因是本机实测：代理端口会漂移（63722 → 52420），而飞书/企业微信直连就可达。
 * 代理失效时推送会静默断掉，且"没收到"本身不产生任何信号。
 */
describe("代理回退", () => {
  const FEISHU = "https://open.feishu.cn/open-apis/bot/v2/hook/token-1";

  it("代理发不出去时，自动直连重试一次并成功", async () => {
    const calls: Array<string | null> = [];
    const io: Transport = async (_url, _opts, deps) => {
      calls.push(deps.proxy ?? null);
      if (deps.proxy) throw new PushPreSendError("代理连接超时");
      return { status: 200, body: '{"code":0}' };
    };
    const out = await dispatchPush(msg(), {
      config: cfg({ feishuUrls: [FEISHU], proxy: "http://127.0.0.1:63722" }), io,
    });
    expect(out[0].ok).toBe(true);
    expect(calls).toEqual(["http://127.0.0.1:63722", null]);
  });

  it("没配代理时失败就失败，不多试（没有可退的路）", async () => {
    const calls: Array<string | null> = [];
    const io: Transport = async (_u, _o, deps) => {
      calls.push(deps.proxy ?? null);
      throw new Error("ENOTFOUND");
    };
    const out = await dispatchPush(msg(), { config: cfg({ feishuUrls: [FEISHU] }), io });
    expect(out[0].ok).toBe(false);
    expect(calls).toEqual([null]);
  });

  /** 请求体发出去之前的三类失败：服务端一定没见过这条消息，换直连重发是安全的 */
  for (const [label, err] of [
    ["代理拒连", new PushPreSendError("代理连接失败：connect ECONNREFUSED 127.0.0.1:63722")],
    ["CONNECT 非 200", new PushPreSendError("代理 CONNECT 返回 403")],
    ["代理连接超时", new PushPreSendError("代理连接超时")],
  ] as const) {
    it(`${label}：直连重试一次`, async () => {
      const calls: Array<string | null> = [];
      const io: Transport = async (_u, _o, deps) => {
        calls.push(deps.proxy ?? null);
        if (deps.proxy) throw err;
        return { status: 200, body: '{"code":0}' };
      };
      const out = await dispatchPush(msg(), {
        config: cfg({ feishuUrls: [FEISHU], proxy: "http://127.0.0.1:63722" }), io,
      });
      expect(out[0].ok).toBe(true);
      expect(calls).toEqual(["http://127.0.0.1:63722", null]);
    });
  }

  /**
   * 请求已经发出去、只是响应慢：服务端很可能已经收下了。
   * 这时再直连发一次，手机上就是两条一模一样的消息 —— 宁可报失败。
   */
  for (const [label, err] of [
    ["推送请求超时（请求已发出）", new Error("推送请求超时")],
    ["连接被重置（请求已发出）", Object.assign(new Error("socket hang up"), { code: "ECONNRESET" })],
  ] as const) {
    it(`${label}：不重试，避免重复消息`, async () => {
      const calls: Array<string | null> = [];
      const io: Transport = async (_u, _o, deps) => {
        calls.push(deps.proxy ?? null);
        throw err;
      };
      const out = await dispatchPush(msg(), {
        config: cfg({ feishuUrls: [FEISHU], proxy: "http://127.0.0.1:63722" }), io,
      });
      expect(out[0].ok).toBe(false);
      expect(out[0].error).toContain(err.message);
      expect(calls).toEqual(["http://127.0.0.1:63722"]);
    });
  }

  it("收到响应就不重试——哪怕业务码是错的，否则用户会收到两条", async () => {
    const calls: Array<string | null> = [];
    const io: Transport = async (_u, _o, deps) => {
      calls.push(deps.proxy ?? null);
      return { status: 200, body: '{"code":19001}' };
    };
    await dispatchPush(msg(), {
      config: cfg({ feishuUrls: [FEISHU], proxy: "http://127.0.0.1:63722" }), io,
    });
    expect(calls).toEqual(["http://127.0.0.1:63722"]);
  });
});

describe("pushOutbound", () => {
  it("没配通道时不抛异常、不发网络", () => {
    const saved = { ...process.env };
    for (const k of ["PANTRADER_PUSH_WECOM", "PANTRADER_PUSH_BARK", "PANTRADER_PUSH_URL",
      "PANTRADER_PUSH_FEISHU"]) {
      delete process.env[k];
    }
    expect(() => pushOutbound(msg())).not.toThrow();
    process.env = saved;
  });
});

describe("requestHttps", () => {
  it("目标是本机不可达地址时，超时后 reject 而不是挂住", async () => {
    await expect(
      requestHttps("https://192.0.2.1:8443/x", { method: "GET", headers: {} }, { timeoutMs: 400 })
    ).rejects.toThrow();
  }, 5000);
});

/**
 * requestHttps 走代理时的错误分类 —— 只用本机 127.0.0.1 上的假代理，不碰任何真实 webhook。
 */
describe("requestHttps 代理阶段", () => {
  const TARGET = "https://open.feishu.cn/open-apis/bot/v2/hook/never-sent";

  /** 起一个本机假代理；onConnect 决定怎么回 CONNECT */
  async function fakeProxy(onConnect: (sock: Socket) => void) {
    const server = http.createServer();
    const sockets = new Set<Socket>();
    server.on("connect", (_req, sock: Socket) => { sockets.add(sock); onConnect(sock); });
    await new Promise<void>(r => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as AddressInfo).port;
    return {
      url: `http://127.0.0.1:${port}`,
      close: () => new Promise<void>(r => {
        for (const s of sockets) s.destroy();
        server.close(() => r());
      }),
    };
  }

  it("代理端口拒连 → PushPreSendError（可以直连重发）", async () => {
    // 先占一个端口再放掉，确保它此刻没人听
    const p = await fakeProxy(() => {});
    await p.close();
    const err = await requestHttps(TARGET, { method: "POST", headers: {}, body: "{}" },
      { proxy: p.url, timeoutMs: 2000 }).catch(e => e);
    expect(isPreSendError(err)).toBe(true);
  });

  it("CONNECT 返回非 200 → PushPreSendError", async () => {
    const p = await fakeProxy(sock => sock.end("HTTP/1.1 403 Forbidden\r\n\r\n"));
    try {
      const err = await requestHttps(TARGET, { method: "POST", headers: {}, body: "{}" },
        { proxy: p.url, timeoutMs: 2000 }).catch(e => e);
      expect(isPreSendError(err)).toBe(true);
      expect(String(err.message)).toContain("403");
    } finally { await p.close(); }
  });

  it("握手阶段超时 → PushPreSendError；隧道之后才通也绝不再发请求", async () => {
    let tunnelBytes = 0;
    const p = await fakeProxy(sock => {
      sock.on("data", b => { tunnelBytes += b.length; });
      sock.on("error", () => {});
      // 晚于超时才放行隧道：若实现没检查 settled，会在这之后把 TLS/请求发进来
      setTimeout(() => {
        if (!sock.destroyed) sock.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      }, 300);
    });
    try {
      const err = await requestHttps(TARGET, { method: "POST", headers: {}, body: "{}" },
        { proxy: p.url, timeoutMs: 100 }).catch(e => e);
      expect(isPreSendError(err)).toBe(true);
      await new Promise(r => setTimeout(r, 500));
      expect(tunnelBytes).toBe(0);
    } finally { await p.close(); }
  }, 5000);

  it("不走代理时的超时 → 普通错误（不属于握手阶段）", async () => {
    const err = await requestHttps("https://192.0.2.1:8443/x", { method: "GET", headers: {} },
      { timeoutMs: 300 }).catch(e => e);
    expect(err).toBeInstanceOf(Error);
    expect(isPreSendError(err)).toBe(false);
  }, 5000);
});

/**
 * flushPushes：`pnpm job` 跑完就 process.exit，不等在途推送的话请求会被半路掐断。
 */
describe("flushPushes", () => {
  const deferred = () => {
    let resolve!: () => void, reject!: (e: Error) => void;
    const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
  };

  it("没有在途推送时立刻返回 true", async () => {
    expect(await flushPushes(10)).toBe(true);
  });

  it("等到在途推送全部落地（成功或失败都算）", async () => {
    const a = deferred(), b = deferred();
    trackPush(a.promise);
    trackPush(b.promise);
    expect(pendingPushes()).toBe(2);
    setTimeout(() => a.resolve(), 20);
    setTimeout(() => b.reject(new Error("网络挂了")), 40);
    expect(await flushPushes(2000)).toBe(true);
    expect(pendingPushes()).toBe(0);
  });

  it("有上限：等不完就返回 false，不会卡住退出", async () => {
    const a = deferred();
    trackPush(a.promise);
    const t0 = Date.now();
    expect(await flushPushes(50)).toBe(false);
    expect(Date.now() - t0).toBeLessThan(1000);
    a.resolve();
    expect(await flushPushes(1000)).toBe(true);
  });

  it("等待期间新登记的推送也会一起等", async () => {
    const a = deferred(), b = deferred();
    trackPush(a.promise);
    setTimeout(() => { trackPush(b.promise); a.resolve(); }, 10);
    setTimeout(() => b.resolve(), 40);
    expect(await flushPushes(2000)).toBe(true);
    expect(pendingPushes()).toBe(0);
  });
});
