/**
 * 新浪复权因子（后复权）。
 *
 * 为什么是新浪而不是东财：**库里的日线就是新浪的**。
 *
 * 实测 2026-09-22：东财与新浪的后复权算法不是同一套。以浦发(600000)为例，
 * 1999 年两者完全吻合，2005 年差 2.5%，2026 年差 61%，且比值随时间漂移 ——
 * 这意味着两条序列的**涨跌幅本身就不同**，不是简单的缩放差异。
 * 拿东财的因子去乘新浪的价格，得到的是一条哪边都不属于的序列。
 *
 * 新浪因子与新浪原始价的自洽性是**验证过**的（拿本地库里的日线对了两个除权日）：
 *   2026-07-16 因子比 1.0472 → 理论除权跌幅 -4.51%，实际原始价 -4.94%
 *   2025-07-16 因子比 1.0303 → 理论 -2.94%，实际 -3.23%
 * 两次都落在日内波动的合理范围内。
 *
 * 数据形态：`var sh600000hfq={"total":29,"data":[{"d":"2026-07-16","f":"17.39..."}]}`
 * 尾部还跟一段 JS 混淆注释。列表按日期降序，且**带一条 1900-01-01 的哨兵**
 * （f=1），所以上市前的任何日期都能落到一条记录上，不必特判。
 */
import type { SourceClient } from "@/lib/data/client";
import { marketSymbol } from "@/lib/data/sources/sina";

const SINA_REFERER = "https://finance.sina.com.cn";

/**
 * 「这只票没有除权记录」≠「采集失败」。
 *
 * 与 sina.ts 的 SourceNoData 同一套道理：新股、长期没分红送转的票本来就没有记录，
 * 记成缺口会让 data_gap 永远挂着一批回补不掉的条目，把真事故淹掉。
 */
export class SourceNoAdjust extends Error {
  constructor(public readonly code: string) {
    super(`sina has no adjust factors for ${code}`);
    this.name = "SourceNoAdjust";
  }
}

/**
 * 这个源不覆盖这只票。
 *
 * 实测 2026-09-23：5,888 只里只有 3 只稳定 404（810011/810013/810014，
 * 都是北交所"定向转让"代码），连打三次全 404，而同一时刻正常票返回 200。
 *
 * 注意这个数字曾经被误报成 343 —— 那次是熔断器的连带伤害：这 3 只排在代码序前面，
 * 把主机熔断之后，后面 340 只北交所票全部拿到 "circuit open" 被算成失败。
 * 修掉"404 不计入熔断"之后重跑，340 只全部成功。
 * 教训：一批**看起来同类**的失败，很可能只有头几条是真的。
 *
 * 必须与 SourceNoAdjust 分开：后者是"这只票确实没有过除权"，因子 1.0 就是**正确答案**；
 * 而这里是"查不到"，那些票里有分红的会拿着 1.0 当复权价用，**是错的，只是我们无从修正**。
 * 混为一谈会让一个已知的数据缺口被伪装成正常状态。
 *
 * 也不能记成可回补缺口：343 条永远补不掉的记录会把真正的采集事故淹掉
 * （sina.ts 的 SourceNoData 注释里记着同一个教训）。
 */
export class AdjustUnsupported extends Error {
  constructor(public readonly code: string) {
    super(`sina does not serve adjust factors for ${code}`);
    this.name = "AdjustUnsupported";
  }
}

export interface AdjustFactor {
  /** 生效日（含当天） */
  date: string;
  /** 累计后复权因子。后复权价 = 原始价 × factor */
  factor: number;
}

/**
 * 解析 hfq.js。
 *
 * 非贪婪匹配到第一个 `}` 后跟分号/换行/注释起始 —— 尾部那段混淆注释里什么字符都有，
 * 贪婪匹配会把它一起吃进来导致 JSON.parse 失败。
 */
export function parseAdjustFactors(text: string, code: string): AdjustFactor[] {
  const m = /=\s*(\{[\s\S]*?\})\s*(?:;|\n|\/\*|$)/.exec(text);
  if (m === null) {
    throw new Error(`sina adjust unexpected payload for ${code}: ${text.slice(0, 80)}`);
  }
  let raw: any;
  try { raw = JSON.parse(m[1]); }
  catch { throw new Error(`sina adjust unparsable json for ${code}: ${m[1].slice(0, 80)}`); }

  const rows: any[] = Array.isArray(raw?.data) ? raw.data : [];
  if (rows.length === 0) throw new SourceNoAdjust(code);

  const out: AdjustFactor[] = rows.map(r => {
    const date = String(r?.d ?? "").slice(0, 10);
    const factor = Number(r?.f);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      throw new Error(`sina adjust 日期不合法 for ${code}: ${JSON.stringify(r?.d)}`);
    }
    // 0 或负因子会把整段历史价格清零或翻负，而乘出来的结果不会报错，只会安静地全错
    if (!Number.isFinite(factor) || factor <= 0) {
      throw new Error(`sina adjust 因子非正 for ${code}@${date}: ${JSON.stringify(r?.f)}`);
    }
    return { date, factor };
  });

  return out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

/**
 * 某一天生效的因子：取**不晚于该日**的最后一条。
 *
 * 空表返回 1：没有除权记录 = 不需要复权，这是合法状态，不是缺数据。
 * 返回 0 或 null 才是危险的 —— 前者把价格清零，后者迫使每个调用点自己决定怎么兜底。
 */
export function factorAt(rows: AdjustFactor[], date: string): number {
  let f = 1;
  for (const r of rows) {
    if (r.date <= date) f = r.factor;
    else break;
  }
  return f;
}

export async function fetchAdjustFactors(
  client: SourceClient, code: string
): Promise<AdjustFactor[]> {
  const sym = marketSymbol(code);
  const url = `https://finance.sina.com.cn/realstock/company/${sym}/hfq.js`;
  const r = await client.get(url, { referer: SINA_REFERER });
  if (!r.ok) {
    // 404 是"这个源没有这只票"，与限频/超时/5xx 不同：重试一万次也还是 404
    if (r.status === 404) throw new AdjustUnsupported(code);
    throw new Error(`sina adjust request failed for ${code}: ${r.error}`);
  }
  return parseAdjustFactors(r.text, code);
}
