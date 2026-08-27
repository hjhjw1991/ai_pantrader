/**
 * 主线识别与龙头温度计（spec §8.2）。
 *
 * 必查链写死，不做成可关闭的参数 —— 这不是洁癖，是 2026-07-27 主线级漏扫的根因：
 * 板块涨幅榜给的是**均值**，一条链里几十只票拖后腿，均值可以排到第 9 名，
 * 但链内已经有一只 3 板龙头在封板。只按涨幅榜 TopN 取主线，整条链会被跳过。
 * 所以必查链走另一条判据：**链内有没有龙头封板**，与均值排名无关。
 *
 * 配置里 StrategyConfig.选股.主线识别.必查链 只能"叠加"，不能"替换/清空"：
 * 传空数组照扫四条链，这一点有测试守着。
 */
import type { FactorSpec, PointInTimeView, ZtRow } from "@/lib/contracts";
import { barsUpTo, pctChange, pnum, parr, pstr, round6, adjClose, evalDate } from "@/lib/factors/util";

/** 写死。改这里要同时改 spec §8.2 与相关测试 */
export const 必查链 = ["半导体全链", "军工", "电网", "资源"] as const;

/**
 * 链 → 板块名关键词。板块名来自东财板块榜与 zt_pool.sector，措辞不统一
 * （"覆铜板" / "PCB" / "半导体" 都属半导体全链），所以用关键词包含匹配。
 * 匹配顺序按 必查链 的顺序，先到先得 —— "覆铜板" 含 "铜"，
 * 如果先匹配到 资源 就会把半导体链的票归错，所以半导体全链必须排在资源之前。
 */
export const 必查链关键词: Record<string, string[]> = {
  半导体全链: [
    "半导体", "芯片", "集成电路", "存储", "封测", "封装", "光刻", "硅片",
    "覆铜板", "PCB", "CPO", "光模块", "IC", "晶圆", "特气", "电子化学",
  ],
  军工: ["军工", "国防", "航空", "航天", "船舶", "兵装", "导弹", "卫星", "雷达"],
  电网: ["电网", "输变电", "特高压", "智能电网", "配电", "电力设备", "变压器"],
  资源: ["有色", "稀土", "黄金", "铜", "铝", "锂", "煤炭", "石油", "钢铁", "矿", "磷", "钨"],
};

/** 板块名归到哪条必查链上；不属于任何链返回 null */
export function chainOf(sector: string | null): string | null {
  if (sector === null) return null;
  for (const chain of 必查链) {
    if (必查链关键词[chain].some(k => sector.includes(k))) return chain;
  }
  return null;
}

export interface MainlineHit {
  name: string;
  source: "板块榜" | "必查链龙头";
  /** 板块榜均值涨幅；必查链命中时可能取不到（链名不是板块名），为 null */
  pct: number | null;
  leaderCode: string | null;
  limitUpCount: number;
  maxLbc: number;
  /**
   * 这条主线实际对应的**真实板块名**。
   *
   * 必须带出来：必查链的 name 是链名（"半导体全链"），而板块榜与 zt_pool 里的名字是
   * "半导体材料 / 半导体设备 / 集成电路制造"。策略层拿链名去和板块名做子串互含
   * 一个都匹配不上 —— 于是"按主线选票"这件事对必查链型主线整个失效，
   * 而表现只是候选少了几只，不报错、不告警。链→板块的对应关系只有本模块知道
   * （必查链关键词在这里），所以由本模块交出去。
   */
  sectors: string[];
}

export interface MainlineResult {
  mainlines: MainlineHit[];
  /** 实际扫过的链，用于自证"必查链没被关掉" */
  扫描的链: string[];
  hasSectorRank: boolean;
  hasZtPool: boolean;
}

/** 同一天板块榜有多个时点快照，只取最后一个时点（盘中滚动写入，早盘那条是过程量） */
function latestRankBySector(view: PointInTimeView, date: string): Map<string, { pct: number; leaderCode: string | null }> {
  const out = new Map<string, { pct: number; ts: string; leaderCode: string | null }>();
  for (const r of view.sectorRank(date)) {
    const prev = out.get(r.sector);
    if (prev === undefined || r.ts >= prev.ts) {
      out.set(r.sector, { pct: r.pct, ts: r.ts, leaderCode: r.leaderCode });
    }
  }
  return new Map([...out].map(([k, v]) => [k, { pct: v.pct, leaderCode: v.leaderCode }]));
}

export interface MainlineOpts {
  板块涨幅榜TopN?: number;
  /** 只能追加，写死的四条永远在里面 */
  必查链?: string[];
  /** 链内至少几只涨停才算主线 */
  链内涨停下限?: number;
}

export function identifyMainlines(
  view: PointInTimeView, date: string, opts: MainlineOpts = {}
): MainlineResult {
  const topN = opts.板块涨幅榜TopN ?? 3;
  const minZt = opts.链内涨停下限 ?? 1;
  // 叠加而非替换：配置想加链可以，想去掉写死的四条不行
  const chains = [...必查链, ...(opts.必查链 ?? []).filter(c => !(必查链 as readonly string[]).includes(c))];

  const ranks = latestRankBySector(view, date);
  const zt = view.ztPool(date);

  const byRank: MainlineHit[] = [...ranks.entries()]
    .sort((a, b) => (b[1].pct - a[1].pct) || (a[0] < b[0] ? -1 : 1))
    .slice(0, topN)
    .map(([sector, v]) => {
      const members = zt.filter(z => z.sector === sector);
      return {
        name: sector, source: "板块榜" as const, pct: round6(v.pct),
        leaderCode: v.leaderCode ?? leaderOf(members),
        limitUpCount: members.length, maxLbc: maxLbcOf(members),
        // 板块榜命中时 name 本身就是真实板块名
        sectors: [sector],
      };
    });

  const byChain: MainlineHit[] = [];
  for (const chain of chains) {
    if (byRank.some(m => chainOf(m.name) === chain)) continue;   // 均值榜已经把这条链带进来了
    const members = zt.filter(z => chainOf(z.sector) === chain);
    if (members.length < minZt) continue;
    // 链下真实出现过的板块名：板块榜里的 + 今日涨停池里的，去重后交给策略层
    const chainSectors = [...new Set([
      ...[...ranks.keys()].filter(sc => chainOf(sc) === chain),
      ...members.map(z => z.sector).filter((x): x is string => typeof x === "string" && x.length > 0),
    ])].sort();
    byChain.push({
      name: chain, source: "必查链龙头", pct: null,
      leaderCode: leaderOf(members), limitUpCount: members.length, maxLbc: maxLbcOf(members),
      sectors: chainSectors,
    });
  }

  return {
    mainlines: [...byRank, ...byChain],
    扫描的链: chains,
    hasSectorRank: ranks.size > 0,
    hasZtPool: zt.length > 0,
  };
}

function maxLbcOf(rows: ZtRow[]): number {
  return rows.reduce((m, r) => Math.max(m, r.lbc ?? 0), 0);
}

/** 龙头 = 连板最高，同板取封单最大。封单是"谁更硬"的直接证据 */
function leaderOf(rows: ZtRow[]): string | null {
  const sorted = [...rows].sort((a, b) =>
    (b.lbc ?? 0) - (a.lbc ?? 0) || (b.sealAmt ?? 0) - (a.sealAmt ?? 0) || (a.code < b.code ? -1 : 1));
  return sorted.length > 0 ? sorted[0].code : null;
}

/* --------------------------------- 因子 --------------------------------- */

const 主线识别: FactorSpec<string[]> = {
  name: "主线识别", version: "1.0.0", group: "thermo",
  defaults: { 板块涨幅榜TopN: 3, 链内涨停下限: 1 },
  fn: ctx => {
    const date = evalDate(ctx.view, ctx.params);
    const r = identifyMainlines(ctx.view, date, {
      板块涨幅榜TopN: pnum(ctx.params, "板块涨幅榜TopN", 3),
      链内涨停下限: pnum(ctx.params, "链内涨停下限", 1),
      必查链: parr(ctx.params, "必查链"),
    });
    // 板块榜与涨停池都不可回补，缺快照时这个因子只能算"猜"，置信度必须掉下来
    const confidence = round6((r.hasSectorRank ? 0.8 : 0.4) * (r.hasZtPool ? 1 : 0.7));
    return {
      name: "主线识别", version: "1.0.0",
      value: r.mainlines.map(m => m.name),
      label: r.mainlines.map(m => `${m.name}${m.source === "必查链龙头" ? "(必查链)" : ""}`).join("/"),
      provenance: "real", confidence,
      inputs: {
        日期: date, 明细: r.mainlines, 扫描的链: r.扫描的链,
        有板块榜: r.hasSectorRank, 有涨停池: r.hasZtPool,
      },
    };
  },
};

/**
 * 龙头温度计（spec §8 温度计组）。
 *
 * 用户买不起/买不了真龙头，做的是次优影子票，所以龙头本身不是标的，是**方向指示器**：
 * 龙头封板 → 主线活，影子票可拿；龙头炸板 → 分歧，影子票只做回踩不追；
 * 龙头退潮 → 影子票先撤，不等它自己破位。
 */
const 龙头温度计: FactorSpec<number> = {
  name: "龙头温度计", version: "1.0.0", group: "thermo",
  defaults: { 板块: "", 退潮跌幅: -3 },
  fn: ctx => {
    const date = evalDate(ctx.view, ctx.params);
    const sector = pstr(ctx.params, "板块", "");
    const chain = chainOf(sector);
    const match = (z: ZtRow) =>
      sector === "" ? true : (z.sector === sector || (chain !== null && chainOf(z.sector) === chain));

    const today = ctx.view.ztPool(date).filter(match);
    if (today.length > 0) {
      const leader = leaderOf(today)!;
      const row = today.find(z => z.code === leader)!;
      const 分歧 = (row.openTimes ?? 0) > 0;
      return {
        name: "龙头温度计", version: "1.0.0",
        value: 分歧 ? 1 : 2, label: 分歧 ? "分歧" : "封板",
        provenance: "real", confidence: 0.85,
        inputs: { 日期: date, 板块: sector, 龙头: leader, 连板: row.lbc, 炸板次数: row.openTimes, 封单额: row.sealAmt },
      };
    }

    // 今日板块内无涨停：看昨日龙头今天怎么走，判滞涨还是退潮
    const prevDay = ctx.view.prevTradingDay(date);
    const yest = prevDay === null ? [] : ctx.view.ztPool(prevDay).filter(match);
    if (yest.length > 0) {
      const leader = leaderOf(yest)!;
      const bars = barsUpTo(ctx.view, leader, date, 2);
      const pct = bars.length >= 2 ? round6(pctChange(adjClose(bars[0]), adjClose(bars[1]))) : null;
      const 退潮线 = pnum(ctx.params, "退潮跌幅", -3);
      const 退潮 = pct !== null && pct <= 退潮线;
      return {
        name: "龙头温度计", version: "1.0.0",
        value: 退潮 ? -1 : 0, label: 退潮 ? "退潮" : "滞涨",
        provenance: "real", confidence: pct === null ? 0.3 : 0.6,
        inputs: { 日期: date, 板块: sector, 龙头: leader, 龙头今日涨幅: pct },
      };
    }

    return {
      name: "龙头温度计", version: "1.0.0",
      value: 0, label: "无涨停池数据",
      provenance: "real", confidence: 0,
      inputs: { 日期: date, 板块: sector },
    };
  },
};

export const SECTOR_FACTORS: FactorSpec<any>[] = [主线识别, 龙头温度计];
