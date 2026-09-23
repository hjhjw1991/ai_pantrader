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
  /**
   * 单个主机上的 HTTP 重试次数，透传给 httpGet。默认走 httpGet 自己的 2 次。
   *
   * 批量场景要显式传 0：httpGet 的重试之间要睡 1s、2s，而这里外面还套着
   * 10 个主机的轮换 —— 一个注定失败的请求就变成 10 × 3 次尝试、约 40 秒。
   * 496 个行业里只要有几十个这样的，整批就跑不完了（实测 4 分钟只走了 68 个）。
   * 批量的正确做法是单次快速失败，把重试留给外层的多轮。
   */
  retries?: number;
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
      const r = await client.get(buildUrl(host), {
        referer: EM_REFERER,
        ...(o.retries === undefined ? {} : { retries: o.retries }),
      });
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

/* ─────────────────────────── 板块涨幅榜 ─────────────────────────── */

export interface SectorRankEntry {
  /** 东财板块代码，如 BK1340。库里不存，仅用于排错 */
  bk: string;
  sector: string;
  /** 涨幅，**百分数**（6.39 表示 6.39%），与 quote_snapshot.pct 同口径 */
  pct: number;
  leaderCode: string | null;
}

/**
 * 行业板块涨幅榜（`fs=m:90+t:2`）。
 *
 * 只取行业板块，不取概念板块（t:3）：概念板块高度重叠且随东财随时增删，
 * 拿它做"主线识别"会让同一波行情在榜上出现四五次，把 TopN 挤满。
 *
 * f3 的单位是 **万分之一**（639 = 6.39%），这里除以 100 归一成百分数 ——
 * 库里 pct 一律百分数，混着存迟早会有一处按错口径比阈值。
 */
/**
 * 单页上限。实测这个接口 **pz 超过 100 也只回 100** —— 请求 200 拿回来的还是 100，
 * 而 total 是 496。不分页就会静默只拿到前 100 个行业，剩下的票在 代码→行业 映射里
 * 查不到，再被主线筛当成"不在主线上"挡掉：一个看起来完全正常、
 * 其实少了三分之二市场的候选池。
 */
const CLIST_PAGE_MAX = 100;

export async function fetchSectorRank(
  client: SourceClient,
  o: RotationOpts & { top?: number; allPages?: boolean } = {}
): Promise<SectorRankEntry[]> {
  const pz = Math.min(CLIST_PAGE_MAX, o.allPages === true ? CLIST_PAGE_MAX : (o.top ?? CLIST_PAGE_MAX));
  const out: SectorRankEntry[] = [];

  for (let pn = 1; ; pn++) {
    const r = await getWithHostRotation(
      client,
      // EM_PUSH2_HOSTS 存的是短名（"82.push2"），域名要在这里补齐 —— 与 fetchAllSecurities 一致
      host => `https://${host}.eastmoney.com/api/qt/clist/get?pn=${pn}&pz=${pz}&po=1&fid=f3` +
        // f128（领涨股名称）必须一起要：实测只要 f12,f14,f3,f140 时，f140 不会回来；
        // 加上 f128 之后两个都有。我们只存代码，f128 纯粹是为了把 f140 带出来。
        `&fs=m%3A90%2Bt%3A2&fields=f12%2Cf14%2Cf3%2Cf128%2Cf140&ut=${UT}`,
      "sector rank", o
    );

    const data = JSON.parse(r.text)?.data;
    const diff = data?.diff;
    if (diff === undefined || diff === null) {
      if (pn === 1) throw new Error("eastmoney sector rank unexpected payload");
      break;                       // 翻到空页 = 到底了
    }
    // 东财这个接口的 diff 有时是数组、有时是以序号为键的对象，两种都要认
    const list: any[] = Array.isArray(diff) ? diff : Object.values(diff);
    out.push(...mapSectorRows(list));

    if (o.allPages !== true) break;
    const total = Number(data?.total ?? 0);
    // pn 天花板兜底，防翻页失控（496/100 → 5 页，20 页很充裕）
    if (list.length === 0 || out.length >= total || pn >= 20) break;
  }
  return out;
}

function mapSectorRows(list: any[]): SectorRankEntry[] {
  return list
    .filter(x => x !== null && typeof x === "object" && typeof x.f14 === "string")
    // f3 缺失时整条丢掉，不补 0：0% 会被当成"这个板块今天没动"读
    .filter(x => typeof x.f3 === "number" && Number.isFinite(x.f3))
    .map(x => ({
      bk: String(x.f12 ?? ""),
      sector: String(x.f14),
      pct: x.f3 / 100,
      leaderCode: typeof x.f140 === "string" && x.f140.length > 0 ? x.f140 : null,
    }));
}

/* ─────────────────────────── 跌停池 ─────────────────────────── */

export interface DtEntry { code: string; name: string; sealAmt: number }

/**
 * 跌停池。与涨停池同一个接口族，实测 **date 参数同样无效** ——
 * 传 20260826 返回的 qdate 是 20260827。所以它和涨停池一样是纯增量资产，
 * 错过当天就永久没有，失败必须显式记 gap。
 *
 * 空池是**合法结果**（今天没有跌停），不能当成失败：把"0 家跌停"报成错误，
 * 会让择时那边永远读不到"今天很稳"这个真实信号。
 */
export async function fetchDtPool(client: SourceClient, date: string): Promise<DtEntry[]> {
  const url = `https://push2ex.eastmoney.com/getTopicDTPool?ut=${UT}` +
    `&dpt=wz.ztzt&Pageindex=0&pagesize=600&sort=fund%3Aasc&date=${date}`;
  const r = await client.get(url, { referer: EM_REFERER });
  if (!r.ok) throw new Error(`eastmoney dtpool failed for ${date}: ${r.error}`);

  const j = JSON.parse(r.text);
  const pool = j?.data?.pool;
  // pool 为空数组 = 今天没有跌停；pool 缺失 = 报文变了，那是错误
  if (pool === undefined || pool === null) {
    throw new Error(`eastmoney dtpool unexpected payload for ${date}`);
  }
  if (!Array.isArray(pool)) throw new Error(`eastmoney dtpool pool is not an array for ${date}`);

  return pool.map((x: any) => ({
    code: String(x.c), name: String(x.n), sealAmt: Number(x.fund ?? 0),
  }));
}

/* ─────────────────────────── 外围标的 ─────────────────────────── */

/**
 * 外围标的 → 东财 secid。secid 全部实地验证过，不是照猜的：
 *   A50  104.CN00Y  A50期指当月连续（用期指而非现货 100.XIN9：A 股开盘前它就在动，
 *                   而"外围传导"要的正是隔夜到盘前这段的风险偏好）
 *   SOX  251.SOX    费城半导体指数
 *   XAU  101.GC00Y  COMEX黄金
 *   OIL  102.CL00Y  NYMEX原油
 * 键名与 lib/factors/macro.ts 的 DEFAULT_MACRO_SYMBOLS 对齐，改一边必须改另一边。
 */
export const MACRO_SECIDS: Record<string, string> = {
  A50: "104.CN00Y",
  SOX: "251.SOX",
  XAU: "101.GC00Y",
  OIL: "102.CL00Y",
};

export interface MacroEntry { symbol: string; price: number; pct: number }

/**
 * 单个外围标的的最新报价。f43 现价、f170 涨跌幅（百分数）、f58 名称。
 * 一个标的一个请求：这个接口不接受多 secid，而标的只有四个，不值得为它做批量。
 */
export async function fetchMacroQuote(
  client: SourceClient, symbol: string
): Promise<MacroEntry> {
  const secid = MACRO_SECIDS[symbol];
  if (secid === undefined) throw new Error(`未知外围标的 ${symbol}（不在 MACRO_SECIDS 里）`);

  const r = await client.get(
    `https://push2.eastmoney.com/api/qt/stock/get?ut=${UT}&fltt=2&invt=2` +
    `&secid=${secid}&fields=f57%2Cf58%2Cf43%2Cf170`,
    { referer: EM_REFERER }
  );
  if (!r.ok) throw new Error(`eastmoney macro ${symbol}(${secid}) failed: ${r.error}`);

  const d = JSON.parse(r.text)?.data;
  if (d === null || d === undefined) throw new Error(`eastmoney macro ${symbol}(${secid}) 无数据`);
  const price = Number(d.f43), pct = Number(d.f170);
  // 停市时东财会回 "-"，Number("-") 是 NaN。宁可报错也不落一个 0 —— 0% 会被读成"外围平稳"
  if (!Number.isFinite(price) || !Number.isFinite(pct)) {
    throw new Error(`eastmoney macro ${symbol}(${secid}) 报价不是数字：f43=${d.f43} f170=${d.f170}`);
  }
  return { symbol, price, pct };
}

/* ─────────────────────── 板块成分股 ─────────────────────── */

export interface SectorMember { code: string; name: string }

/**
 * 某个行业板块的成分股（`fs=b:BKxxxx`）。
 *
 * 用来建立全市场的 代码 → 行业 映射。此前库里唯一的映射来源是 zt_pool.sector，
 * 只覆盖曾涨停过的票，于是候选池只能从涨停池里选。
 *
 * 一次拿全（pz=600）：单个行业成分最多两三百只，分页只会多打一倍请求，
 * 而东财的限流额度很紧。
 */
export async function fetchSectorMembers(
  client: SourceClient, bk: string, o: RotationOpts = {}
): Promise<SectorMember[]> {
  const r = await getWithHostRotation(
    client,
    host => `https://${host}.eastmoney.com/api/qt/clist/get?pn=1&pz=600&po=1&fid=f3` +
      `&fs=b%3A${encodeURIComponent(bk)}&fields=f12%2Cf14&ut=${UT}`,
    `sector members ${bk}`, o
  );

  const j = JSON.parse(r.text);
  const diff = j?.data?.diff;
  // total=0 且 diff=null 是合法的（空板块），不能当报文异常
  if (diff === undefined || diff === null) return [];
  const list: any[] = Array.isArray(diff) ? diff : Object.values(diff);

  return list
    .filter(x => x !== null && typeof x === "object" && typeof x.f12 === "string")
    // 只要 6 位 A 股代码：板块里混着的指数/其它市场代码不属于我们的宇宙
    .filter(x => /^\d{6}$/.test(x.f12))
    .map(x => ({ code: String(x.f12), name: String(x.f14 ?? "") }));
}

/* -------------------------------- 估值 -------------------------------- */

export interface ValuationRow {
  code: string;
  /** 市盈率。**亏损股为负**，不要当成"便宜"，也不要当成缺数据 */
  pe: number | null;
  pb: number | null;
  /** 总市值 / 流通市值，单位元 */
  mktcap: number | null;
  floatMktcap: number | null;
}

/**
 * clist 的估值字段号与单票接口**不一样**，这里踩过：
 * 单票 `qt/stock/get` 用 f162(PE)/f167(PB) 且数值放大 100 倍；
 * 而 clist 用 **f9(PE) / f23(PB) / f20(总市值) / f21(流通市值)**，
 * 配合 fltt=2 直接给可用数值。拿单票的字段号去查 clist，返回的是一片 "-"，
 * 而那看起来就像"今天全市场都没有估值数据"。
 */
export const EM_VALUATION_FIELDS = "f12,f9,f23,f20,f21";

/** 东财用字符串 "-" 表示没有值。转成 null —— 转成 0 会让亏损股和无数据混为一谈 */
function numOrNull(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v !== "string" || v === "-" || v.trim() === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export function parseValuationPage(text: string): { rows: ValuationRow[]; total: number } {
  let j: any;
  try { j = JSON.parse(text); }
  catch { throw new Error(`em valuation unexpected payload: ${text.slice(0, 80)}`); }

  const diff = j?.data?.diff;
  // 限流常表现成结构不对（null / 对象而非数组），而不是一个空列表。
  // 当成空列表会让这一轮"成功"地写入 0 条，缺口表里什么都不留
  if (!Array.isArray(diff)) {
    throw new Error(`em valuation diff 不是数组：${JSON.stringify(j?.data?.diff)?.slice(0, 60)}`);
  }
  return {
    total: Number(j?.data?.total ?? 0),
    rows: diff.map((x: any) => ({
      code: String(x.f12),
      pe: numOrNull(x.f9),
      pb: numOrNull(x.f23),
      mktcap: numOrNull(x.f20),
      floatMktcap: numOrNull(x.f21),
    })),
  };
}

/**
 * 全市场估值。按代码升序分页 —— 与 fetchSecurities 同一条理由：
 * 按涨幅排序会让行在翻页间漂移，实测 36 页里重复 229 条，有重复就必然有遗漏。
 */
export async function fetchValuations(
  client: SourceClient, o: RotationOpts & { pageSize?: number; onPage?: (pn: number, got: number, total: number) => void } = {}
): Promise<ValuationRow[]> {
  const pz = o.pageSize ?? 100;
  const out: ValuationRow[] = [];
  for (let pn = 1; ; pn++) {
    const r = await getWithHostRotation(
      client,
      host => `https://${host}.eastmoney.com/api/qt/clist/get?pn=${pn}&pz=${pz}` +
        `&po=0&np=1&fltt=2&invt=2&fid=f12&fs=${EM_MARKET_FILTER}&fields=${EM_VALUATION_FIELDS}&ut=${UT}`,
      `valuation page ${pn}`,
      { rounds: o.rounds, backoffMs: o.backoffMs, retries: o.retries }
    );
    const { rows, total } = parseValuationPage(r.text);
    if (rows.length === 0) break;
    out.push(...rows);
    o.onPage?.(pn, out.length, total);
    if (out.length >= total || rows.length < pz) break;
  }
  return out;
}

/* -------------------------------- 解禁 -------------------------------- */

export interface LiftRow {
  code: string;
  /** 解禁日 */
  freeDate: string;
  /** 解禁股数，**股**（东财给的是万股，这里换算过） */
  freeShares: number | null;
  /** 解禁市值，**元**（东财给的是万元，这里换算过） */
  liftMktcap: number | null;
  /** 占解禁前流通股的比例，**小数**（0.05 = 5%），不是百分数 */
  freeRatio: number | null;
  /** 占总股本的比例，小数 */
  totalRatio: number | null;
  /** 限售股类型：首发原股东 / 定向增发机构配售 / 股权激励 … */
  shareType: string;
}

const WAN = 1e4;

function numOrNullLift(v: unknown): number | null {
  if (v === null || v === undefined || v === "" || v === "-") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * 解析 RPT_LIFT_STAGE 的一页。
 *
 * 单位换算在这里一次做完：东财的股数是万股、市值是万元，而比例是小数。
 * 三种口径混在一张表里，下游一旦拿"万股"去除"股"，比例就错四个数量级，
 * 而那个错的数字看起来仍然像个比例。
 *
 * 9201（返回数据为空）是合法的空：那段日期确实没有解禁。
 * 其它失败码一律抛错 —— 9501 是报表名写错、9701 是报表下线，都不是"没有解禁"。
 */
export function parseLiftPage(text: string): { rows: LiftRow[]; pages: number } {
  let j: any;
  try { j = JSON.parse(text); }
  catch { throw new Error(`em lift unexpected payload: ${text.slice(0, 80)}`); }

  if (j?.success === false) {
    if (Number(j?.code) === 9201) return { rows: [], pages: 0 };
    throw new Error(`em lift failed: code=${j?.code} msg=${j?.message}`);
  }
  const data = j?.result?.data;
  if (!Array.isArray(data)) {
    throw new Error(`em lift result.data 不是数组：${JSON.stringify(j?.result)?.slice(0, 60)}`);
  }
  const mul = (v: unknown, k: number): number | null => {
    const n = numOrNullLift(v);
    return n === null ? null : Math.round(n * k * 100) / 100;
  };
  return {
    pages: Number(j?.result?.pages ?? 1),
    rows: data.map((x: any) => ({
      code: String(x.SECURITY_CODE),
      freeDate: String(x.FREE_DATE ?? "").slice(0, 10),
      freeShares: mul(x.CURRENT_FREE_SHARES, WAN),
      liftMktcap: mul(x.LIFT_MARKET_CAP, WAN),
      freeRatio: numOrNullLift(x.FREE_RATIO),
      totalRatio: numOrNullLift(x.TOTAL_RATIO),
      shareType: String(x.FREE_SHARES_TYPE ?? ""),
    })),
  };
}

const LIFT_PAGE_SIZE = 500;

/**
 * 按解禁日区间拉全市场解禁日历。
 *
 * 为什么能用来回测：解禁日在限售股**发行时**就定了（首发 1~3 年、定增 6~18 个月），
 * 所以"未来 90 天有没有解禁"在评估日那天几乎总是已知的。
 * 残余的前视只来自"评估日之后才完成的定增" —— 那批股份的解禁日离评估日至少半年，
 * 落进 90 天窗口的概率很低。
 */
export async function fetchLiftSchedule(
  client: SourceClient, from: string, to: string,
  onPage?: (page: number, pages: number, got: number) => void
): Promise<LiftRow[]> {
  const out: LiftRow[] = [];
  for (let page = 1; ; page++) {
    const filter = encodeURIComponent(`(FREE_DATE>='${from}')(FREE_DATE<='${to}')`);
    const url = "https://datacenter-web.eastmoney.com/api/data/v1/get" +
      `?reportName=RPT_LIFT_STAGE&columns=SECURITY_CODE,FREE_DATE,CURRENT_FREE_SHARES,` +
      `LIFT_MARKET_CAP,FREE_RATIO,TOTAL_RATIO,FREE_SHARES_TYPE` +
      `&source=WEB&client=WEB&pageNumber=${page}&pageSize=${LIFT_PAGE_SIZE}` +
      `&sortColumns=FREE_DATE,SECURITY_CODE&sortTypes=1,1&filter=${filter}`;
    const r = await client.get(url, { referer: "https://data.eastmoney.com/" });
    if (!r.ok) throw new Error(`em lift request failed page ${page}: ${r.error}`);
    const { rows, pages } = parseLiftPage(r.text);
    out.push(...rows);
    onPage?.(page, pages, out.length);
    if (rows.length === 0 || page >= pages) break;
  }
  return out;
}

/* ------------------------------- 公告列表 ------------------------------- */

export interface NoticeRow {
  code: string;
  noticeDate: string;
  title: string;
}

/**
 * 标题是不是一份**减持计划**（而不是计划的进展、完成或终止）。
 *
 * 东财"持股变动"栏目里预披露与实施结果混在一起 —— 实测某一天 71 条里约一半是
 * "实施完成 / 期限届满 / 实施结果 / 提前终止"。把它们当成新计划，会让一只
 * 刚减完、已经没有抛压的票被判成"未来三个月有减持"。
 *
 * 规则：含"减持"且含"预披露"或"计划"，同时不含任何表示"已经结束或只是进展"的词。
 * 增持计划不算 —— 它是利好，混进来会把利好当利空。
 */
export function isReductionPlanTitle(title: string): boolean {
  if (!title.includes("减持")) return false;
  if (!/预披露|计划/.test(title)) return false;
  /**
   * "变更"**不**排除：变更可能是把减持比例调高。这里的代价不对称 ——
   * 多判一条只是多抓一次 F10 页（它显示的总是最新版本），漏判则是漏掉一个加重了的风险。
   * "提前"也不单独排除："提前终止"已被"终止"覆盖，单独的"提前"反而会误伤。
   */
  return !/完成|届满|结果|终止|进展|实施情况|增持/.test(title);
}

export function parseNoticePage(text: string): { rows: NoticeRow[]; total: number } {
  let j: any;
  try { j = JSON.parse(text); }
  catch { throw new Error(`em notice unexpected payload: ${text.slice(0, 80)}`); }
  const list = j?.data?.list;
  if (!Array.isArray(list)) {
    throw new Error(`em notice data.list 不是数组：${JSON.stringify(j?.data)?.slice(0, 60)}`);
  }
  const rows: NoticeRow[] = [];
  for (const x of list) {
    const code = x?.codes?.[0]?.stock_code;
    if (typeof code !== "string") continue;
    rows.push({
      code,
      noticeDate: String(x?.notice_date ?? "").slice(0, 10),
      title: String(x?.title ?? ""),
    });
  }
  return { rows, total: Number(j?.data?.total_hits ?? 0) };
}

/** "持股变动"类公告（f_node=7），按公告日区间分页 */
export async function fetchHoldingChangeNotices(
  client: SourceClient, from: string, to: string
): Promise<NoticeRow[]> {
  const out: NoticeRow[] = [];
  const pz = 100;
  for (let page = 1; ; page++) {
    const url = "https://np-anotice-stock.eastmoney.com/api/security/ann" +
      `?page_size=${pz}&page_index=${page}&ann_type=A&client_source=web&f_node=7` +
      `&begin_time=${from}&end_time=${to}`;
    const r = await client.get(url, { referer: "https://data.eastmoney.com/" });
    if (!r.ok) throw new Error(`em notice request failed page ${page}: ${r.error}`);
    const { rows, total } = parseNoticePage(r.text);
    out.push(...rows);
    if (rows.length < pz || out.length >= total) break;
  }
  return out;
}
