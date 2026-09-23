/**
 * 同花顺 F10 事件页（basic.10jqka.com.cn/{code}/event.html）。
 *
 * 只为一件事来这里：**股东减持计划**。
 *
 * 为什么是同花顺：东财 datacenter 里根本没有"减持计划"这张报表
 * （实测 111 个报表名、34 个 F10 chunk 里没有任何 plan/reduce 类），
 * 它那边的 RPT_SHARE_HOLDER_INCREASE 是**已实施**的事后披露 ——
 * 查 END_DATE >= 今天返回空，一条未来日期的记录都没有。
 * 巨潮只给标题 + PDF，东财公告正文是自由文本、句式随年份变。
 *
 * 同花顺把计划写成**模板化的一句话**：
 *   公司其他股东烟台恒邦集团有限公司计划自2026-10-23起至2027-01-22，
 *   拟减持不超过1430万股，占总股本比例1.00%
 * 一条正则就能拿到身份、起止日、上限股数、比例。代价是：
 *   - 只能按个股抓（没有全市场列表）—— 所以先用东财公告列表找出当天发预披露的票
 *   - 每只票只留最近约 2 条 —— 所以**只能做实盘，做不了深回测**
 *
 * 页面编码是 GBK，由调用方用 { encoding: "gbk" } 取回。
 */
import type { SourceClient } from "@/lib/data/client";

export interface HoldingPlan {
  /** 身份 + 股东名，原样保留（"公司其他股东烟台恒邦集团有限公司" / "公司高管张三、李四"） */
  actor: string;
  direction: "增持" | "减持";
  startDate: string;
  endDate: string;
  /** 计划上限，**股** */
  maxShares: number;
  /** 占总股本比例上限，**小数** */
  maxRatio: number;
}

const BLOCK = /<strong[^>]*>\s*增减持计划[：:]\s*<\/strong>\s*<span[^>]*>([\s\S]*?)<\/span>/g;

/**
 * 句式：{身份股东}计划自{起}起至{止}，拟{增|减}持不超过{数}{单位}股，占总股本比例{X}%
 *
 * 单位有 万 / 亿 / 无 三种（实测高管小额减持常写"43.29万股"）。
 * 对不上的句子**整条跳过**，而不是造一条字段为空的计划 ——
 * 一条"上限为空"的减持计划到了下游，会被当成"没有上限"，那是最坏的读法。
 */
const SENTENCE =
  /^(.+?)计划自(\d{4}-\d{2}-\d{2})起至(\d{4}-\d{2}-\d{2})[，,]\s*拟(增|减)持不超过([\d.]+)\s*(万|亿)?股[，,]\s*占总股本比例([\d.]+)%/;

export function parseHoldingPlans(html: string): HoldingPlan[] {
  const out: HoldingPlan[] = [];
  for (const m of html.matchAll(BLOCK)) {
    const text = m[1].replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
    const s = SENTENCE.exec(text);
    if (s === null) continue;
    const n = Number(s[5]);
    const mult = s[6] === "亿" ? 1e8 : s[6] === "万" ? 1e4 : 1;
    const ratio = Number(s[7]);
    if (!Number.isFinite(n) || !Number.isFinite(ratio)) continue;
    out.push({
      actor: s[1].trim(),
      direction: s[4] === "增" ? "增持" : "减持",
      startDate: s[2],
      endDate: s[3],
      maxShares: Math.round(n * mult),
      maxRatio: Math.round((ratio / 100) * 1e8) / 1e8,
    });
  }
  return out;
}

export async function fetchHoldingPlans(client: SourceClient, code: string): Promise<HoldingPlan[]> {
  const r = await client.get(`https://basic.10jqka.com.cn/${code}/event.html`, {
    referer: "https://basic.10jqka.com.cn/",
    encoding: "gbk",
  });
  if (!r.ok) throw new Error(`ths event page failed for ${code}: ${r.error}`);
  // 正常页 20 万字节以上；远小于此多半是阻断页或跳转页，不能当成"这只票没有计划"
  if (r.text.length < 2000) {
    throw new Error(`ths event page too short for ${code} (${r.text.length} chars)，疑似被拦`);
  }
  return parseHoldingPlans(r.text);
}
