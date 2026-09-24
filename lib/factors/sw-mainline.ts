/**
 * 申万主线：按申万一级行业把当天的涨停股聚起来，涨停扎堆、高度板所在的行业就是主线。
 *
 * 与「主线识别」（板块榜叠加必查链）的区别：不预设任何名单。
 * 必查链是人写死的四条（半导体全链 / 军工 / 电网 / 资源），它能防"板块均值掩盖链内龙头"的漏扫，
 * 但代价是永远只盯这四条 —— 行情转去别的行业时它看不见。这里换成数据说话：
 *   - 聚集：一级行业里涨停家数 ≥ 最少涨停，且按家数、最高连板、涨停占比排序取前 主线数 个
 *   - 高度：全市场最高板（≥ 高度门槛）所在的行业无论家数多少都算主线 —— 这正是必查链想防的那种漏扫，
 *     但判据是"那里有没有高度龙头"，而不是"它在不在名单上"
 *
 * 行业归属按评估日的申万历史归属（PIT），2021-12 之前申万这套分类还不存在，那段日子判不出来。
 * 名字对齐：候选源里的板块名在真快照日是东财的名字，代理日是申万三级 ——
 * 所以每条主线的明细里把成员实际出现过的板块名（申万三级 + 涨停池原名）一并交出去，引擎靠它匹配。
 */
import type { FactorResult, FactorSpec, ZtRow } from "@/lib/contracts";
import { evalDate, pnum, round6 } from "@/lib/factors/util";
import { crossRowsFor } from "@/lib/pit/snapshot-or-proxy";

export interface SwCluster {
  name: string;
  indexCode: string;
  limitUpCount: number;
  maxLbc: number;
  leaderCode: string;
  /** 龙头在涨停池里的原板块名：龙头温度计按它找龙头 */
  leaderSector: string | null;
  members: number | null;
  ratio: number | null;
  /** 成员实际出现过的板块名（申万三级 + 涨停池原名），引擎按它给候选匹配主线 */
  sectors: string[];
  source: "聚集" | "高度";
}

const fin = (x: unknown): number => (typeof x === "number" && Number.isFinite(x) ? x : 0);

/** 纯计算：涨停股 + 行业归属 → 主线列表。拆出来是为了单测不必造整个视图 */
export function swClusters(
  zt: ZtRow[],
  l1Of: (code: string) => { indexCode: string; indexName: string } | null,
  l3Of: (code: string) => string | null,
  memberCount: Map<string, number>,
  o: { minZt: number; topN: number; heightMin: number },
): { clusters: SwCluster[]; unmapped: number } {
  const by = new Map<string, { name: string; rows: ZtRow[] }>();
  let unmapped = 0;
  for (const z of zt) {
    const l1 = l1Of(z.code);
    if (l1 === null) { unmapped++; continue; }
    if (!by.has(l1.indexCode)) by.set(l1.indexCode, { name: l1.indexName, rows: [] });
    by.get(l1.indexCode)!.rows.push(z);
  }
  const all = [...by.entries()].map(([code, g]): SwCluster => {
    const rows = [...g.rows].sort((a, b) => (b.lbc ?? 0) - (a.lbc ?? 0) || fin(b.sealAmt) - fin(a.sealAmt) || (a.code < b.code ? -1 : 1));
    const members = memberCount.get(code) ?? null;
    const sectors = new Set<string>();
    for (const r of rows) {
      const l3 = l3Of(r.code);
      if (l3) sectors.add(l3);
      if (typeof r.sector === "string" && r.sector.length > 0) sectors.add(r.sector);
    }
    return {
      name: g.name, indexCode: code, limitUpCount: rows.length, maxLbc: rows[0].lbc ?? 0,
      leaderCode: rows[0].code, leaderSector: rows[0].sector ?? null,
      members, ratio: members && members > 0 ? round6(rows.length / members) : null,
      sectors: [...sectors].sort(), source: "聚集",
    };
  });
  const ranked = all.filter(c => c.limitUpCount >= o.minZt)
    .sort((a, b) => b.limitUpCount - a.limitUpCount || b.maxLbc - a.maxLbc || (b.ratio ?? 0) - (a.ratio ?? 0) || (a.name < b.name ? -1 : 1))
    .slice(0, o.topN);
  // 高度龙头所在的行业：家数不够也要带上
  const top = [...all].sort((a, b) => b.maxLbc - a.maxLbc || b.limitUpCount - a.limitUpCount || (a.name < b.name ? -1 : 1))[0];
  if (top !== undefined && top.maxLbc >= o.heightMin && !ranked.some(c => c.indexCode === top.indexCode)) {
    ranked.push({ ...top, source: "高度" });
  }
  return { clusters: ranked, unmapped };
}

const 申万主线: FactorSpec<string[]> = {
  name: "申万主线", version: "1.0.0", group: "thermo",
  defaults: { 最少涨停: 3, 主线数: 3, 高度门槛: 3 },
  fn: ctx => {
    const date = evalDate(ctx.view, ctx.params).slice(0, 10);
    const cr = crossRowsFor(ctx.view, date);
    const out = (value: string[], label: string, confidence: number, inputs: Record<string, unknown>, proxy = false): FactorResult<string[]> =>
      ({ name: "申万主线", version: "1.0.0", value, label, provenance: proxy ? "proxy" : "real", confidence: round6(confidence), inputs: { 日期: date, ...inputs } });
    if (cr.zt.length === 0) return out([], "无涨停池数据", 0, {});

    const l1 = new Map(ctx.view.industryCrossSection(1).map(r => [r.code, r]));
    const l3 = new Map(ctx.view.industryCrossSection(3).map(r => [r.code, r.indexName]));
    if (l1.size === 0) return out([], "无申万行业归属", 0, { 说明: "评估日早于申万分类可用期，或行业快照未入库" });
    const memberCount = new Map<string, number>();
    for (const r of l1.values()) memberCount.set(r.indexCode, (memberCount.get(r.indexCode) ?? 0) + 1);

    const { clusters, unmapped } = swClusters(
      cr.zt, c => l1.get(c) ?? null, c => l3.get(c) ?? null, memberCount,
      {
        minZt: Math.max(1, Math.floor(pnum(ctx.params, "最少涨停", 3))),
        topN: Math.max(1, Math.floor(pnum(ctx.params, "主线数", 3))),
        heightMin: Math.max(2, Math.floor(pnum(ctx.params, "高度门槛", 3))),
      },
    );
    const coverage = 1 - unmapped / cr.zt.length;
    // 代理截面只知道收盘封没封住，置信打折；行业映射不全再按覆盖率打折
    const conf = (cr.ztProxy ? 0.85 * 0.75 : 0.85) * coverage;
    const label = clusters.length === 0 ? "没有涨停扎堆的行业"
      : clusters.map(c => `${c.name}(${c.limitUpCount}${c.source === "高度" ? `，${c.maxLbc}板` : ""})`).join(" / ");
    return out(clusters.map(c => c.name), label, conf, {
      涨停家数: cr.zt.length, 未映射: unmapped, 代理截面: cr.ztProxy,
      明细: clusters.map(c => ({
        name: c.name, source: c.source, limitUpCount: c.limitUpCount, maxLbc: c.maxLbc, leaderCode: c.leaderCode,
        leaderSector: c.leaderSector, members: c.members, ratio: c.ratio, sectors: c.sectors,
      })),
    }, cr.ztProxy);
  },
};

export const SW_MAINLINE_FACTORS: FactorSpec<any>[] = [申万主线];
