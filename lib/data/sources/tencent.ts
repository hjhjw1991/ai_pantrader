import type { SourceClient } from "@/lib/data/client";
import { marketSymbol } from "@/lib/data/sources/sina";

export const GTIMG_BATCH_SIZE = 60;

export interface Quote {
  code: string; name: string; price: number; pct: number;
  turnover: number; amplitude: number;
  open: number; high: number; low: number; prevClose: number;
  /** 行情时间戳，形如 20260803140706；非交易日会停在上一交易日 */
  quoteTs: string;
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
// [1]名称 [2]代码 [3]现价 [4]昨收 [5]今开 [30]行情时间戳
// [32]涨跌幅% [33]最高 [34]最低 [38]换手率 [43]振幅
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
      quoteTs: f[30] ?? "",
    });
  }
  return out;
}

/**
 * 问行情源「今天是不是在交易」。
 *
 * 交易日历由日线生成，而当日日线要收盘后才有——盘中查表会判成非交易日，
 * 于是所有盘中 job 全部跳过，一条实时数据都采不到。
 * 实时快照的时间戳在非交易日会停在上一交易日，正好可以拿来判当日。
 */
export async function probeTradingDay(
  client: SourceClient, todayCompact: string
): Promise<boolean> {
  const r = await client.get("https://qt.gtimg.cn/q=sh000001", { encoding: "gbk" });
  if (!r.ok) throw new Error(`gtimg trading-day probe failed: ${r.error}`);
  const quotes = parseGtimg(r.text);
  if (quotes.length === 0) throw new Error("gtimg trading-day probe returned no quote");
  return quotes[0].quoteTs.slice(0, 8) === todayCompact;
}

export async function fetchGtimgBatch(
  client: SourceClient, codes: string[]
): Promise<Quote[]> {
  if (codes.length > GTIMG_BATCH_SIZE) {
    throw new Error(`gtimg batch size ${codes.length} exceeds limit ${GTIMG_BATCH_SIZE}`);
  }
  const url = `https://qt.gtimg.cn/q=${codes.map(marketSymbol).join(",")}`;
  const r = await client.get(url, { encoding: "gbk" });
  if (!r.ok) throw new Error(`gtimg batch failed (${codes.length} codes): ${r.error}`);
  return parseGtimg(r.text);
}
