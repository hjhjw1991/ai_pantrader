/**
 * 申万宏源研究（swsresearch.com）行业分类。
 *
 * 为什么要这个源：库里原有的行业归属只有东财 BK 板块（security_sector），
 * 那是行业与概念混编的单张快照，没有层级、没有历史。申万 2021 版是研究界通用口径，
 * 31 个一级 / 134 个二级 / 346 个三级，**三层互不重叠且覆盖全市场**。
 *
 * 三件必须知道的事（全部为 2026-09-22 实测）：
 *
 * 1. **WAF 阻断返回 HTTP 200 + HTML**，不是 429、不是 5xx。
 *    只看 res.ok 会把 15KB 的阻断页当成功数据吞下去，解析出 0 条成分，
 *    于是"这个行业今天没有成分股"——静默的、看不出来的数据污染。
 *    所以本模块在解析前先认阻断页，命中即抛 SwBlocked。
 *
 * 2. **并发 ≥3 就开始被拦**（实测 8 并发 13% 拦截率）。必须串行。
 *    拦截是单次的、不封 IP，串行重试一次即可恢复。
 *
 * 3. **历史区间拿不到**。官网带「结束日期」的 SwClass.xls 是 2022-03-25 的冻结快照
 *    且该列 4701 行全空；行业调整公告停在 2021-11-23。但成分 API 本身是活的
 *    （实测电子行业最新一条 beginningdate 为 2026-09-11）。
 *    所以退出日期只能靠**我们自己按周快照做差分**推出来 —— 这是这个采集器
 *    要尽早开跑的唯一理由：它攒的是别处买不到的时间序列。
 *
 * 本期只采一级与三级，不采二级：二级没有可靠的代码规则（名字带 Ⅱ 的只有 45 个，
 * 而二级有 131 个非空），靠猜会把风格指数混进来。三级颗粒度比二级更细，
 * 主线判定够用；二级等拿到官方层级映射再补。
 */
import type { SourceClient } from "@/lib/data/client";

export const SW_REFERER = "https://www.swsresearch.com/";
const API = "https://www.swsresearch.com/institute-sw/api";

/** 阻断页命中即抛，不能退化成空结果 */
export class SwBlocked extends Error {
  constructor(public readonly indexCode: string) {
    super(`swsresearch WAF blocked request for ${indexCode}`);
    this.name = "SwBlocked";
  }
}

export interface SwComponent {
  code: string;
  name: string;
  /** 最新权重；缺失时为 null。不要填 0——0 是一个会参与排序的合法权重 */
  weight: number | null;
  /** 计入日期 YYYY-MM-DD。新股等于上市日；老股出现新日期表示被重分类 */
  beginningDate: string;
}

export interface SwIndex {
  code: string;
  name: string;
}

/**
 * 申万一级行业，2021 版共 31 个。
 *
 * 为什么写死而不是从 index_name 过滤：接口里 801*** 末位为 0 的有 39 个，
 * 多出来的 8 个是风格指数与旧版残留（申万制造/消费/投资/服务、申万300指数、
 * Imp_农林牧渔/家用电器/餐饮旅游）。没有任何字段能把它们和真行业区分开，
 * 只能靠名字，而靠名字过滤会在申万改名的那天悄悄多出或少掉一个行业。
 * 写死 31 个是可审计的：变更要经过一次 code review，而不是某天自动生效。
 */
export const SW_LEVEL1: readonly SwIndex[] = [
  { code: "801010", name: "农林牧渔" },
  { code: "801030", name: "基础化工" },
  { code: "801040", name: "钢铁" },
  { code: "801050", name: "有色金属" },
  { code: "801080", name: "电子" },
  { code: "801110", name: "家用电器" },
  { code: "801120", name: "食品饮料" },
  { code: "801130", name: "纺织服饰" },
  { code: "801140", name: "轻工制造" },
  { code: "801150", name: "医药生物" },
  { code: "801160", name: "公用事业" },
  { code: "801170", name: "交通运输" },
  { code: "801180", name: "房地产" },
  { code: "801200", name: "商贸零售" },
  { code: "801210", name: "社会服务" },
  { code: "801230", name: "综合" },
  { code: "801710", name: "建筑材料" },
  { code: "801720", name: "建筑装饰" },
  { code: "801730", name: "电力设备" },
  { code: "801740", name: "国防军工" },
  { code: "801750", name: "计算机" },
  { code: "801760", name: "传媒" },
  { code: "801770", name: "通信" },
  { code: "801780", name: "银行" },
  { code: "801790", name: "非银金融" },
  { code: "801880", name: "汽车" },
  { code: "801890", name: "机械设备" },
  { code: "801950", name: "煤炭" },
  { code: "801960", name: "石油石化" },
  { code: "801970", name: "环保" },
  { code: "801980", name: "美容护理" },
] as const;

/** 三级行业的代码前缀。实测这六个前缀的条数正好等于 346，与 2021 版三级行业数一致 */
const LEVEL3_PREFIXES = ["850", "851", "852", "857", "858", "859"];

/**
 * 三级行业应有的条数。数目变了意味着申万调整了分类体系，
 * 那是需要人看一眼的事件（历史归因会断代），不该默默跟随。
 */
export const SW_LEVEL3_EXPECTED = 346;

/** 阻断页没有 JSON 结构；正常响应一定以 { 开头 */
function looksBlocked(text: string): boolean {
  const head = text.trimStart().slice(0, 400);
  return !head.startsWith("{") || head.includes("请求已被阻断");
}

/** 注意 Number("") === 0：空字符串必须先挡掉，否则缺失权重会变成一个参与排序的 0 */
function asNumOrNull(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v !== "string" || v.trim() === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export function parseComponents(text: string, indexCode: string): SwComponent[] {
  if (looksBlocked(text)) throw new SwBlocked(indexCode);

  let raw: any;
  try { raw = JSON.parse(text); }
  catch { throw new Error(`sw components unexpected payload for ${indexCode}: ${text.slice(0, 80)}`); }

  if (raw?.code !== "200") {
    throw new Error(`sw components failed for ${indexCode}: code=${raw?.code} msg=${raw?.message}`);
  }

  const results: any[] = Array.isArray(raw?.data?.results) ? raw.data.results : [];
  const count = asNumOrNull(raw?.data?.count);

  // 少票是静默的：分页没取全时接口照样 200，只是结果少一截。
  // 这类污染在下游表现为"某些票查不到行业"，查起来要绕很远，所以在这里就断掉。
  if (count !== null && count > results.length) {
    throw new Error(
      `sw components truncated for ${indexCode}: count=${count} got=${results.length}（page_size 不够或被分页）`);
  }

  return results.map(r => ({
    code: String(r.stockcode),
    name: String(r.stockname),
    weight: asNumOrNull(r.newweight),
    beginningDate: String(r.beginningdate ?? "").slice(0, 10),
  }));
}

export function parseIndexNames(text: string): SwIndex[] {
  if (looksBlocked(text)) throw new SwBlocked("index_name");

  let raw: any;
  try { raw = JSON.parse(text); }
  catch { throw new Error(`sw index_name unexpected payload: ${text.slice(0, 80)}`); }

  if (raw?.code !== "200") {
    throw new Error(`sw index_name failed: code=${raw?.code} msg=${raw?.message}`);
  }
  const rows: any[] = Array.isArray(raw?.data) ? raw.data : [];
  return rows.map(r => ({ code: String(r.swindexcode), name: String(r.swindexname) }));
}

export function level3Codes(all: SwIndex[]): SwIndex[] {
  return all.filter(x => LEVEL3_PREFIXES.includes(x.code.slice(0, 3)));
}

export async function fetchComponents(
  client: SourceClient, indexCode: string
): Promise<SwComponent[]> {
  // page_size 给足，一次取完。申万最大的行业（电子）494 只，2000 足够，
  // 且 count 校验会在真的被分页时报错而不是静默少票。
  const url = `${API}/index_publish/details/component_stocks/?swindexcode=${indexCode}&page_size=2000`;
  const r = await client.get(url, { referer: SW_REFERER });
  if (!r.ok) throw new Error(`sw components request failed for ${indexCode}: ${r.error}`);
  return parseComponents(r.text, indexCode);
}

export async function fetchIndexNames(client: SourceClient): Promise<SwIndex[]> {
  const r = await client.get(`${API}/index_name/`, { referer: SW_REFERER });
  if (!r.ok) throw new Error(`sw index_name request failed: ${r.error}`);
  return parseIndexNames(r.text);
}
