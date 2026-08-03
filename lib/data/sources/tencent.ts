import type { SourceClient } from "@/lib/data/client";
import { sinaSymbol } from "@/lib/data/sources/sina";

export const GTIMG_BATCH_SIZE = 60;

export interface Quote {
  code: string; name: string; price: number; pct: number;
  turnover: number; amplitude: number;
  open: number; high: number; low: number; prevClose: number;
}

export function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

const num = (v: string | undefined): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
};

// 字段位置对照实测报文（共 88 段）：
// [1]名称 [2]代码 [3]现价 [4]昨收 [5]今开 [32]涨跌幅% [33]最高 [34]最低 [38]换手率 [43]振幅
export function parseGtimg(text: string): Quote[] {
  const out: Quote[] = [];
  for (const line of text.split("\n")) {
    const m = line.match(/^v_([a-z]{2}\d{6})="([^"]*)";?$/);
    if (!m) continue;              // 跳过 v_pv_none_match 等噪声行
    const f = m[2].split("~");
    if (f.length < 45 || !f[2]) continue;
    out.push({
      code: f[2], name: f[1],
      price: num(f[3]), prevClose: num(f[4]), open: num(f[5]),
      pct: num(f[32]), high: num(f[33]), low: num(f[34]),
      turnover: num(f[38]), amplitude: num(f[43]),
    });
  }
  return out;
}

export async function fetchGtimgBatch(
  client: SourceClient, codes: string[]
): Promise<Quote[]> {
  if (codes.length > GTIMG_BATCH_SIZE) {
    throw new Error(`gtimg batch size ${codes.length} exceeds limit ${GTIMG_BATCH_SIZE}`);
  }
  const url = `https://qt.gtimg.cn/q=${codes.map(sinaSymbol).join(",")}`;
  const r = await client.get(url, { encoding: "gbk" });
  if (!r.ok) throw new Error(`gtimg batch failed (${codes.length} codes): ${r.error}`);
  return parseGtimg(r.text);
}
