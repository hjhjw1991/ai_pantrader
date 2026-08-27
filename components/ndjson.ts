/**
 * NDJSON 流读取。采集 / 回测 / 参数扫描三条长任务共用一份。
 *
 * 三处各写一遍解析必然漂移，而漂移的那一份只在少用的入口上炸 ——
 * 半行缓冲、结束判定这两处尤其容易写错，且错了之后的表现是"偶尔丢最后一条消息"，
 * 极难复现。
 *
 * 约定：**结论写在最后一行**（phase: "done" / "aborted" / "error"），不看 HTTP 状态码 ——
 * 流式响应的状态码在第一个字节就定死了，中途失败没法再改。
 */
export interface NdjsonEvent extends Record<string, unknown> {
  phase?: string;
}

export type StreamOutcome =
  | { kind: "stream"; last: NdjsonEvent | null }
  /** 服务端在开跑之前就拒绝了（参数不合法 / 有别的重活在跑 / 配置不可用），走的是普通 JSON */
  | { kind: "rejected"; status: number; error: string };

export async function readNdjson(
  res: Response,
  onEvent: (e: NdjsonEvent) => void
): Promise<StreamOutcome> {
  if (!res.headers.get("content-type")?.includes("ndjson")) {
    const j = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    return { kind: "rejected", status: res.status, error: String(j.error ?? `HTTP ${res.status}`) };
  }
  if (res.body === null) {
    return { kind: "rejected", status: res.status, error: "服务端没有返回可读流" };
  }

  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let last: NdjsonEvent | null = null;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split("\n");
    // 最后一段留在缓冲里等下一个 chunk：按行切完的尾巴可能是半个 JSON
    buf = lines.pop() ?? "";
    for (const ln of lines) {
      if (ln.trim() === "") continue;
      let ev: NdjsonEvent;
      try { ev = JSON.parse(ln) as NdjsonEvent; } catch { continue; }
      last = ev;
      onEvent(ev);
    }
  }
  return { kind: "stream", last };
}
