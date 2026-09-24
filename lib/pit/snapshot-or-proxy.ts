/**
 * 真快照优先、没有才退回代理截面的选择器。视图层的工具，不是因子实现 ——
 * 引擎（候选池）与因子（主线识别、龙头温度计）都要用，而引擎只依赖 PointInTimeView 契约。
 *
 * 代理截面怎么来的、和真快照差在哪，见 lib/factors/cross-proxy.ts 的抬头。
 */
import type { PointInTimeView, SectorRankRow, ZtRow } from "@/lib/contracts";

export interface CrossRows {
  zt: ZtRow[];
  sectors: SectorRankRow[];
  /** 涨停名单来自日线重建（封单额 / 开板次数为 NaN） */
  ztProxy: boolean;
  /** 板块榜来自日线重建 */
  sectorProxy: boolean;
  /**
   * 板块名是申万三级行业名（不是东财板块名）。为真时，用行业做匹配的一方
   * （候选池量价一路）也必须换成申万口径，否则一个都匹配不上。
   */
  swNames: boolean;
}

/**
 * 涨停名单与板块榜**一起**决定用真的还是代理 —— 两者的板块名必须是同一套。
 *
 * 分开决定会出事：2026-08-03 ~ 08-26 有真涨停池（东财板块名）却没有真板块榜，
 * 板块榜退回代理（申万名）之后，涨停股的板块名与主线名一个都对不上，
 * 涨停池那一路候选会被主线筛整路挡掉，而且不报错。
 *
 *   两样都有真的         → 都用真的
 *   只有真涨停池         → 涨停池留真的（封单额、开板次数是真信息，不丢），板块名换成申万；板块榜用代理
 *   只有真板块榜 / 都没有 → 都用代理（东财板块名映射不到申万，只能整套换）
 *   代理也没有           → 有什么给什么，不标代理
 */
export function crossRowsFor(view: PointInTimeView, date: string): CrossRows {
  const rz = view.ztPool(date), rs = view.sectorRank(date);
  if (rz.length > 0 && rs.length > 0) return { zt: rz, sectors: rs, ztProxy: false, sectorProxy: false, swNames: false };
  const pz = view.ztProxy(date), ps = view.sectorRankProxy(date);
  if (pz.length === 0 && ps.length === 0) return { zt: rz, sectors: rs, ztProxy: false, sectorProxy: false, swNames: false };

  const sectors = ps.map(r => ({ date: r.date, ts: `${r.date} 15:00:00`, sector: r.sector, pct: r.pct, leaderCode: r.leaderCode }));
  if (rz.length > 0) {
    const sw = swSectorOf(view);
    // 映射不到申万的留 null，不回落东财名：留着东财名会被 chainOf 当成另一套名字去匹配，两套名字又混回来了
    return { zt: rz.map(z => ({ ...z, sector: sw(z.code) ?? null })), sectors, ztProxy: false, sectorProxy: true, swNames: true };
  }
  return {
    zt: pz.map(r => ({
      date: r.date, code: r.code, lbc: r.lbc, sector: r.sector,
      // 日线里没有这几样。NaN / null 表示"不知道"，下游若要用必须判 Number.isFinite
      sealAmt: Number.NaN, openTimes: Number.NaN, firstSealTs: null, lastSealTs: null,
    })),
    sectors, ztProxy: true, sectorProxy: true, swNames: true,
  };
}

/** 只要涨停名单时用；决定口径与 crossRowsFor 一致 */
export function ztRowsFor(view: PointInTimeView, date: string): { rows: ZtRow[]; proxy: boolean } {
  const c = crossRowsFor(view, date);
  return { rows: c.zt, proxy: c.ztProxy };
}

/** 代理日用的 代码 → 行业：申万三级、按视图那天的归属（有历史版本，无前视） */
export function swSectorOf(view: PointInTimeView): (code: string) => string | null {
  const m = new Map(view.industryCrossSection(3).map(r => [r.code, r.indexName]));
  return code => m.get(code) ?? null;
}
