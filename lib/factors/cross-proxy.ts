/**
 * 代理截面：真涨停池 / 板块榜不存在的日子，用日线 + 申万行业历史归属重建。
 *
 * 真涨停池 2026-08-03 起、板块榜 2026-08-27 起才开始攒。在那之前，主线识别与候选池
 * 读到的都是空数组 —— 回测与影子盘冷启动在整段历史上什么都没做，而且不报错。
 *
 * 用法纪律（用户 2026-09-24 选定）：**只在那天没有真快照时才用**，用了就要让下游知道。
 * crossRowsFor / ztRowsFor（lib/pit/snapshot-or-proxy.ts）是唯一入口，返回 proxy 标志；
 * 消费方据此标 provenance、降置信。它们放在视图层，因为引擎也要用，而引擎不直接依赖因子实现。
 *
 * 代理与真快照的三处差别，下游必须知道：
 *   1. 名字：申万三级行业名，不是东财的概念 / 行业板块名 —— 代理日的主线偏"行业"
 *   2. 缺字段：日线里没有封单额、开板次数、封板时间。转成 ZtRow 时这几项是 NaN / null，
 *      **不是 0**：0 会被炸板率读成"没炸板"、被封单强度读成"封单为零"
 *   3. 口径：涨停判定与情绪截面同一套（复权涨幅 + 精确涨停价 + 收盘在最高，ST 排除）
 */
import type { PointInTimeView, SectorProxyRow, ZtProxyRow } from "@/lib/contracts";
import { barsUpTo, mean, round6 } from "@/lib/factors/util";
import { DEFAULT_LIMIT_THRESHOLDS, judgeBarLimitUp, wasSt } from "@/lib/factors/limit-up";
import { LBC_CAP } from "@/lib/factors/sentiment";

/** 口径版本。改了任何统计口径都要升，派生表里版本不符的日子会被重建 */
export const CROSS_PROXY_VERSION = "1.0.0";
/** 成分股少于这么多只的行业不上榜：两三只票的行业靠一只涨停就能冲到榜首 */
export const CROSS_PROXY_MIN_MEMBERS = 5;

export function crossSectionProxy(view: PointInTimeView, date: string): { zt: ZtProxyRow[]; sectors: SectorProxyRow[] } {
  const t = DEFAULT_LIMIT_THRESHOLDS;
  const ind = new Map(view.industryCrossSection(3).map(r => [r.code, r.indexName]));
  const pull = LBC_CAP + 3 + (date === view.asOf.slice(0, 10) ? 0 : view.tradingDays(date, view.asOf).length);
  const zt: ZtProxyRow[] = [];
  const bySector = new Map<string, { pcts: number[]; leader: { code: string; pct: number } | null }>();

  for (const sec of view.universe()) {
    const bars = barsUpTo(view, sec.code, date, LBC_CAP + 2, pull);
    const n = bars.length;
    if (n < 2 || bars[n - 1].date !== date) continue;
    const j = judgeBarLimitUp(sec, bars[n - 1], bars[n - 2], t);
    if (j.pct === null) continue;
    const sector = ind.get(sec.code) ?? null;
    const st = wasSt(sec, date);

    if (sector !== null) {
      const g = bySector.get(sector) ?? { pcts: [], leader: null };
      g.pcts.push(j.pct);
      if (!st && (g.leader === null || j.pct > g.leader.pct || (j.pct === g.leader.pct && sec.code < g.leader.code))) {
        g.leader = { code: sec.code, pct: j.pct };
      }
      bySector.set(sector, g);
    }
    if (st || !j.limitUp) continue;
    let lbc = 0;
    while (lbc < LBC_CAP && n - 1 - lbc >= 1 && judgeBarLimitUp(sec, bars[n - 1 - lbc], bars[n - 2 - lbc], t).limitUp) lbc++;
    zt.push({ date, code: sec.code, lbc, sector });
  }

  const sectors: SectorProxyRow[] = [...bySector.entries()]
    .filter(([, g]) => g.pcts.length >= CROSS_PROXY_MIN_MEMBERS)
    .map(([sector, g]) => ({ date, sector, pct: round6(mean(g.pcts)), leaderCode: g.leader?.code ?? null, members: g.pcts.length }))
    .sort((a, b) => (a.sector < b.sector ? -1 : 1));
  zt.sort((a, b) => (a.code < b.code ? -1 : 1));
  return { zt, sectors };
}

export { crossRowsFor, ztRowsFor, swSectorOf } from "@/lib/pit/snapshot-or-proxy";
