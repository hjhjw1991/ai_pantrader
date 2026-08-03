import type { SourceClient } from "@/lib/data/client";

export interface Bar {
  ts: string; o: number; h: number; l: number; c: number; vol: number;
}

/**
 * 「这只票在这个源上没有序列」≠「采集失败」。
 *
 * 实测 2026-08-03：5888 只里有 14 只新浪返回字面量 `null`，
 * 全是刚注册的新股与北交所定向转让代码（嘉立创/绿控传动/优机定转…），
 * 数小时后无负载重试仍是 null —— 是这些代码本来就没有 K 线，不是被限频。
 *
 * 把它记成缺口会让 data_gap 永远挂着 14 条不可能被回补的记录，
 * M0 的出口标准「连续 5 个交易日零缺口」就永远达不到，
 * 而真正的采集事故会被这 14 条常驻噪音淹掉。
 *
 * 注意与空响应体区分：空响应体是限频，必须当失败（见 http.ts）。
 * 这里只认「合法 JSON 的 null」。
 */
export class SourceNoData extends Error {
  constructor(public readonly symbol: string) {
    super(`sina has no series for ${symbol}`);
    this.name = "SourceNoData";
  }
}

export type SinaScale = 1 | 5 | 15 | 30 | 60 | 240;
const SINA_REFERER = "https://finance.sina.com.cn";
const MAX_DATALEN = 1023;

/**
 * 代码 → 带市场前缀的 symbol（新浪与腾讯 gtimg 通用）。
 *
 * 北交所必须用 bj 前缀：实测 sz832317 / sh832317 都返回 v_pv_none_match，
 * 只有 bj832317 有数据。漏掉这条规则会让全部 343 只北交所票取不到行情
 * （一次全市场快照少 343 条，且不会报错，只是静静地少）。
 */
export function marketSymbol(code: string): string {
  if (code.startsWith("6")) return `sh${code}`;
  if (code.startsWith("8") || code.startsWith("43") || code.startsWith("92")) return `bj${code}`;
  return `sz${code}`;
}

/** @deprecated 用 marketSymbol；保留别名避免调用点漏改 */
export const sinaSymbol = marketSymbol;

export async function fetchSinaKline(
  client: SourceClient, code: string, scale: SinaScale, datalen: number
): Promise<Bar[]> {
  return fetchSinaKlineBySymbol(client, marketSymbol(code), scale, datalen);
}

/**
 * 按新浪 symbol 直接取 K 线。指数必须走这里——指数代码不遵循
 * 「6 开头即沪市」的规则（上证指数是 sh000001，而 sinaSymbol("000001")
 * 会算成 sz000001，那是平安银行）。
 */
export async function fetchSinaKlineBySymbol(
  client: SourceClient, symbol: string, scale: SinaScale, datalen: number
): Promise<Bar[]> {
  const code = symbol;
  const len = Math.min(datalen, MAX_DATALEN);
  const url =
    "https://quotes.sina.cn/cn/api/json_v2.php/CN_MarketDataService.getKLineData" +
    `?symbol=${symbol}&scale=${scale}&ma=no&datalen=${len}`;

  const r = await client.get(url, { referer: SINA_REFERER });
  if (!r.ok) throw new Error(`sina kline failed for ${code}@${scale}: ${r.error}`);

  let raw: unknown;
  try { raw = JSON.parse(r.text); }
  catch { throw new Error(`sina kline unexpected payload for ${code}: ${r.text.slice(0, 80)}`); }

  // 字面量 null = 该 symbol 无序列；其它非数组才是真的payload异常
  if (raw === null) throw new SourceNoData(symbol);
  if (!Array.isArray(raw)) {
    throw new Error(`sina kline unexpected payload for ${code}: not an array`);
  }

  return raw.map((x: any) => ({
    ts: String(x.day),
    o: Number(x.open), h: Number(x.high),
    l: Number(x.low), c: Number(x.close), vol: Number(x.volume),
  }));
}
