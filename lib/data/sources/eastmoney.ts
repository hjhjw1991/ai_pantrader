import type { SourceClient } from "@/lib/data/client";
import type { HttpResult } from "@/lib/data/http";

const UT = "7eea3edcaed734bea9cbfc24409ed989";
const EM_REFERER = "https://quote.eastmoney.com/";

/**
 * 东财 push2 的主机分片。实测单主机会被整体限流（连打十几次即空响应），
 * 但分片主机之间限流是独立的，轮换可显著提高成功率。
 */
export const EM_PUSH2_HOSTS = [
  "82.push2", "push2", "1.push2", "7.push2", "13.push2",
  "19.push2", "23.push2", "29.push2", "33.push2", "40.push2",
];

export type Board = "主板" | "创业板" | "科创板" | "北交所";

export function boardOf(code: string): Board {
  if (code.startsWith("300") || code.startsWith("301")) return "创业板";
  if (code.startsWith("688") || code.startsWith("689")) return "科创板";
  if (code.startsWith("8") || code.startsWith("43") || code.startsWith("92")) return "北交所";
  return "主板";
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

export interface RotationOpts {
  /** 全部主机失败后重来的轮数 */
  rounds?: number;
  /** 轮间退避基数，第 n 轮等待 backoffMs * n */
  backoffMs?: number;
}

/**
 * 依次尝试各分片主机，首个成功即返回。
 *
 * 全部主机失败不等于没救——东财是整体限流一小段时间，退避后往往就恢复。
 * 实测：10 个主机第一轮全空，静置 15s 后 82.push2 立刻成功。
 * 所以这里做「轮换 + 轮间退避」，而不是一轮打完就放弃。
 */
async function getWithHostRotation(
  client: SourceClient, buildUrl: (host: string) => string, what: string,
  o: RotationOpts = {}
): Promise<HttpResult & { ok: true }> {
  const rounds = o.rounds ?? 3;
  const backoffMs = o.backoffMs ?? 15_000;
  let errors: string[] = [];

  for (let round = 1; round <= rounds; round++) {
    errors = [];
    for (const host of EM_PUSH2_HOSTS) {
      const r = await client.get(buildUrl(host), { referer: EM_REFERER });
      if (r.ok) return r;
      errors.push(`${host}: ${r.error}`);
    }
    if (round < rounds) await sleep(backoffMs * round);
  }

  throw new Error(
    `eastmoney ${what} failed on all ${EM_PUSH2_HOSTS.length} hosts ` +
    `after ${rounds} rounds — ${errors.join("; ")}`
  );
}

export interface ZtEntry {
  code: string; name: string; lbc: number; sealAmt: number; openTimes: number;
  firstSealTs: string; lastSealTs: string; sector: string; turnover: number;
}

/** 东财把封板时间编码成整数 92500 → 09:25:00 */
const emTime = (v: unknown): string => {
  const s = String(v ?? "").padStart(6, "0");
  return s.length === 6 ? `${s.slice(0, 2)}:${s.slice(2, 4)}:${s.slice(4, 6)}` : "";
};

export async function fetchZtPool(client: SourceClient, date: string): Promise<ZtEntry[]> {
  const url = `https://push2ex.eastmoney.com/getTopicZTPool?ut=${UT}` +
    `&dpt=wz.ztzt&Pageindex=0&pagesize=600&sort=fbt%3Aasc&date=${date}`;
  const r = await client.get(url, { referer: EM_REFERER });
  if (!r.ok) throw new Error(`eastmoney ztpool failed for ${date}: ${r.error}`);

  const j = JSON.parse(r.text);
  const pool = j?.data?.pool;
  if (!Array.isArray(pool)) throw new Error(`eastmoney ztpool unexpected payload for ${date}`);

  return pool.map((x: any) => ({
    code: String(x.c), name: String(x.n),
    lbc: Number(x.lbc ?? 0), sealAmt: Number(x.fund ?? 0),
    openTimes: Number(x.zbc ?? 0),
    firstSealTs: emTime(x.fbt), lastSealTs: emTime(x.lbt),
    sector: String(x.hybk ?? ""), turnover: Number(x.hs ?? 0),
  }));
}

export interface SecurityEntry { code: string; name: string; board: Board }

export interface FetchSecuritiesOpts extends RotationOpts {
  /**
   * 每页拉完立即回调，带本页数据。
   * 调用方应当在这里落库——拉满 5545 只要 56 页，全靠内存攒到最后再写，
   * 任何一页失败就前功尽弃（实测第 28 页挂掉，前 27 页 2700 只全丢）。
   */
  onPage?: (page: number, rows: SecurityEntry[], got: number, total: number) => void;
  /** 从第几页开始，用于断点续拉 */
  startPage?: number;
}

export async function fetchAllSecurities(
  client: SourceClient, o: FetchSecuritiesOpts = {}
): Promise<SecurityEntry[]> {
  const out: SecurityEntry[] = [];
  const pz = 100;
  for (let pn = o.startPage ?? 1; ; pn++) {
    const r = await getWithHostRotation(
      client,
      host => `https://${host}.eastmoney.com/api/qt/clist/get?pn=${pn}&pz=${pz}` +
        `&po=1&np=1&fltt=2&invt=2&fid=f3&fs=m:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23&fields=f12,f14`,
      `clist page ${pn}`,
      { rounds: o.rounds, backoffMs: o.backoffMs }
    );

    const j = JSON.parse(r.text);
    const diff = j?.data?.diff;
    if (!Array.isArray(diff) || diff.length === 0) break;

    const pageRows: SecurityEntry[] = diff.map((x: any) => {
      const code = String(x.f12);
      return { code, name: String(x.f14), board: boardOf(code) };
    });
    out.push(...pageRows);

    const total = Number(j?.data?.total ?? 0);
    o.onPage?.(pn, pageRows, out.length, total);

    const fetchedSoFar = (o.startPage ?? 1) - 1 + Math.ceil(out.length / pz);
    if (fetchedSoFar * pz >= total || diff.length < pz) break;
  }
  return out;
}

export interface LhbEntry {
  date: string; code: string; name: string;
  netAmt: number; buyAmt: number; sellAmt: number; explanation: string;
  d1Chg: number | null; d5Chg: number | null; d10Chg: number | null;
}

const orNull = (v: unknown): number | null =>
  v === null || v === undefined ? null : Number(v);

export async function fetchLhb(client: SourceClient, date: string): Promise<LhbEntry[]> {
  const out: LhbEntry[] = [];
  for (let page = 1; ; page++) {
    const url = "https://datacenter-web.eastmoney.com/api/data/v1/get" +
      `?reportName=RPT_DAILYBILLBOARD_DETAILSNEW&columns=ALL&pageNumber=${page}` +
      `&pageSize=100&filter=(TRADE_DATE%3D%27${date}%27)`;
    const r = await client.get(url, { referer: EM_REFERER });
    if (!r.ok) throw new Error(`eastmoney lhb failed for ${date} page ${page}: ${r.error}`);

    const j = JSON.parse(r.text);
    const rows = j?.result?.data;
    if (!Array.isArray(rows) || rows.length === 0) break;

    for (const x of rows) {
      out.push({
        date,
        code: String(x.SECURITY_CODE),
        name: String(x.SECURITY_NAME_ABBR ?? ""),
        netAmt: Number(x.BILLBOARD_NET_AMT ?? 0),
        buyAmt: Number(x.BILLBOARD_BUY_AMT ?? 0),
        sellAmt: Number(x.BILLBOARD_SELL_AMT ?? 0),
        explanation: String(x.EXPLAIN ?? ""),
        d1Chg: orNull(x.D1_CLOSE_ADJCHRATE),
        d5Chg: orNull(x.D5_CLOSE_ADJCHRATE),
        d10Chg: orNull(x.D10_CLOSE_ADJCHRATE),
      });
    }
    const pages = Number(j?.result?.pages ?? 1);
    if (page >= pages) break;
  }
  return out;
}
