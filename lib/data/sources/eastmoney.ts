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

/**
 * 全市场过滤器。前四段是沪深（total 5545），最后一段是北交所（total 343）。
 * 漏掉北交所那段的话 security 表里北交所票数为 0——实测踩过。
 * 合并后 total 5888。
 */
export const EM_MARKET_FILTER =
  "m:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23,m:0+t:81+s:2048";

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
      // 必须按代码(f12)升序分页，不能按涨幅(f3)。盘中价格在变，
      // 按涨幅排序会让行在翻页间漂移——实测 36 页里重复 229 条，
      // 有重复就必然有遗漏（那次少了 333 只）。
      host => `https://${host}.eastmoney.com/api/qt/clist/get?pn=${pn}&pz=${pz}` +
        `&po=0&np=1&fltt=2&invt=2&fid=f12&fs=${EM_MARKET_FILTER}&fields=f12,f14`,
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

/**
 * 龙虎榜一行 = 一只票的一个上榜原因。同一只票同一天可以有多行。
 * `changeType` 是行身份的一部分（实测四天上 (date, code, changeType) 唯一），
 * 不是可丢的附属字段 —— 早期版本用 (date, code) 做主键，2026-08-03 抓 58 行只存下 30 行。
 */
export interface LhbEntry {
  date: string; code: string; changeType: string; tradeId: number | null;
  name: string;
  /** 真正的上榜原因，如"日换手率达到20%的前5只证券" */
  explanation: string;
  /** EXPLAIN 字段：机构家数 + 3 日成功率统计，不是上榜原因 */
  explainStat: string;
  netAmt: number; buyAmt: number; sellAmt: number;
  billboardDealAmt: number | null; dealAmountRatio: number | null; dealNetRatio: number | null;
  buySeatRaw: string; sellSeatRaw: string;
  buyRatio: number | null; sellRatio: number | null;
  closePrice: number | null; changeRate: number | null; turnoverRate: number | null;
  accumAmount: number | null; freeMarketCap: number | null;
  tradeMarket: string;
  // 上榜当日全为 null，随后逐日回填 → night job 必须滚动重拉才拿得到监督标签
  d1Chg: number | null; d2Chg: number | null; d5Chg: number | null;
  d10Chg: number | null; d20Chg: number | null; d30Chg: number | null;
}

/** 营业部席位明细。无稳定业务主键（机构专用共用 dept_code='0'），落库靠先删后插。 */
export interface LhbSeat {
  date: string; code: string; changeType: string;
  side: "buy" | "sell";
  deptCode: string; deptName: string;
  buyAmt: number; sellAmt: number; netAmt: number;
  buyRatio: number | null; sellRatio: number | null;
  riseProb3d: number | null; buyerTimes3d: number | null;
}

const orNull = (v: unknown): number | null =>
  v === null || v === undefined || v === "" ? null : Number(v);

const LHB_PAGE_SIZE = 500;

/** datacenter 通用分页取数。`result.data` 为空或 `result` 缺失即停。 */
async function fetchDatacenter(
  client: SourceClient, label: string, reportName: string, date: string,
  extraFilter = ""
): Promise<any[]> {
  const out: any[] = [];
  for (let page = 1; ; page++) {
    const url = "https://datacenter-web.eastmoney.com/api/data/v1/get" +
      `?reportName=${reportName}&columns=ALL&pageNumber=${page}` +
      `&pageSize=${LHB_PAGE_SIZE}&filter=(TRADE_DATE%3D%27${date}%27)${extraFilter}`;
    const r = await client.get(url, { referer: EM_REFERER });
    if (!r.ok) throw new Error(`eastmoney ${label} failed for ${date} page ${page}: ${r.error}`);

    const j = JSON.parse(r.text);
    const rows = j?.result?.data;
    if (!Array.isArray(rows) || rows.length === 0) break;
    out.push(...rows);

    const pages = Number(j?.result?.pages ?? 1);
    if (page >= pages) break;
  }
  return out;
}

export async function fetchLhb(client: SourceClient, date: string): Promise<LhbEntry[]> {
  const rows = await fetchDatacenter(
    client, "lhb", "RPT_DAILYBILLBOARD_DETAILSNEW", date
  );
  return rows.map(x => ({
    date,
    code: String(x.SECURITY_CODE),
    changeType: String(x.CHANGE_TYPE ?? ""),
    tradeId: orNull(x.TRADE_ID),
    name: String(x.SECURITY_NAME_ABBR ?? ""),
    explanation: String(x.EXPLANATION ?? ""),
    explainStat: String(x.EXPLAIN ?? ""),
    netAmt: Number(x.BILLBOARD_NET_AMT ?? 0),
    buyAmt: Number(x.BILLBOARD_BUY_AMT ?? 0),
    sellAmt: Number(x.BILLBOARD_SELL_AMT ?? 0),
    billboardDealAmt: orNull(x.BILLBOARD_DEAL_AMT),
    dealAmountRatio: orNull(x.DEAL_AMOUNT_RATIO),
    dealNetRatio: orNull(x.DEAL_NET_RATIO),
    buySeatRaw: String(x.BUY_SEAT_NEW ?? x.BUY_SEAT ?? ""),
    sellSeatRaw: String(x.SELL_SEAT_NEW ?? x.SELL_SEAT ?? ""),
    buyRatio: orNull(x.BUY_RATIO),
    sellRatio: orNull(x.SELL_RATIO),
    closePrice: orNull(x.CLOSE_PRICE),
    changeRate: orNull(x.CHANGE_RATE),
    turnoverRate: orNull(x.TURNOVERRATE),
    accumAmount: orNull(x.ACCUM_AMOUNT),
    freeMarketCap: orNull(x.FREE_MARKET_CAP),
    tradeMarket: String(x.TRADE_MARKET ?? ""),
    d1Chg: orNull(x.D1_CLOSE_ADJCHRATE),
    d2Chg: orNull(x.D2_CLOSE_ADJCHRATE),
    d5Chg: orNull(x.D5_CLOSE_ADJCHRATE),
    d10Chg: orNull(x.D10_CLOSE_ADJCHRATE),
    d20Chg: orNull(x.D20_CLOSE_ADJCHRATE),
    d30Chg: orNull(x.D30_CLOSE_ADJCHRATE),
  }));
}

const SEAT_REPORT = {
  buy: "RPT_BILLBOARD_DAILYDETAILSBUY",
  sell: "RPT_BILLBOARD_DAILYDETAILSSELL",
} as const;

/** 整日席位明细，一个 side 一次请求拉完（实测买方榜 290 行 / 1 页）。 */
export async function fetchLhbSeats(
  client: SourceClient, date: string, side: "buy" | "sell"
): Promise<LhbSeat[]> {
  const rows = await fetchDatacenter(
    client, `lhb-seat-${side}`, SEAT_REPORT[side], date
  );
  return rows.map(x => ({
    date,
    code: String(x.SECURITY_CODE),
    changeType: String(x.CHANGE_TYPE ?? ""),
    side,
    deptCode: String(x.OPERATEDEPT_CODE ?? ""),
    deptName: String(x.OPERATEDEPT_NAME ?? ""),
    buyAmt: Number(x.BUY ?? 0),
    sellAmt: Number(x.SELL ?? 0),
    netAmt: Number(x.NET ?? 0),
    buyRatio: orNull(x.TOTAL_BUYRIO),
    sellRatio: orNull(x.TOTAL_SELLRIO),
    riseProb3d: orNull(x.RISE_PROBABILITY_3DAY),
    buyerTimes3d: orNull(x.TOTAL_BUYER_SALESTIMES_3DAY),
  }));
}
