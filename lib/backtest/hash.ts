import { createHash } from "node:crypto";

/**
 * 结果哈希（spec §17 断言 4：同一份历史输入跑两次，结果哈希必须一致）。
 *
 * 两条纪律：
 *   1. 哈希只覆盖**输入 + 净值/成交序列**。生成时间、机器名、耗时一律不进 ——
 *      否则每次跑都变，断言永远过不了，也就等于没有这条断言。
 *   2. 浮点固定到 10 位再入哈希。同一份代码同一份输入的浮点是逐位相同的，
 *      但一旦以后换了求和顺序（比如并行化），末位抖动会让哈希无意义地变。
 */

const FLOAT_DIGITS = 10;

function normalise(v: unknown): unknown {
  if (typeof v === "number") {
    if (!Number.isFinite(v)) return String(v); // NaN/Infinity 也要能稳定序列化
    return Number(v.toFixed(FLOAT_DIGITS));
  }
  if (Array.isArray(v)) return v.map(normalise);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    // 键排序：对象字面量的书写顺序不该影响哈希
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      out[k] = normalise((v as Record<string, unknown>)[k]);
    }
    return out;
  }
  return v;
}

export function canonicalJson(v: unknown): string {
  return JSON.stringify(normalise(v));
}

export function sha256Hex(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

export function computeResultHash(payload: unknown): string {
  return sha256Hex(canonicalJson(payload));
}
