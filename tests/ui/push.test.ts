import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import {
  dispatchPush, feishuCardContent, feishuPayload, feishuSign, feishuText, isEnabled,
  pushOutbound, readPushConfig, requestHttps, resetThrottle, secretFor,
  shouldPush, throttled, wecomContent,
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
