/**
 * 资金组因子（spec §8）：龙虎榜净买聚类 · 游资席位识别 · 板块净流入。
 *
 * ## lhb 一行 = 一只票的一个上榜原因（migration 003 刚修的坑）
 *
 * 主键是 (date, code, change_type)，**同一只票同一天可以有好几行**。
 * 实测利欧股份 2026-08-03 三行："日换手率达到20%的前5只证券" /
 * "日涨幅偏离值达到7%的前5只证券" / "连续三个交易日内涨幅偏离值累计达到20%的证券"，
 * 每行的 net_amt 都不一样。
 *
 * 于是有两个都错的做法：
 *   ❌ 按 code 去重 —— 丢数据（旧表就是这么丢了 48% 的行）
 *   ❌ 直接求和 —— **重复计钱**。不同上榜原因各自有一份"前 5 买卖席位"榜单，
 *      这些榜单常常是同一批席位的同一笔成交，相加等于把一笔钱数了三遍。
 *
 * 本模块的决定：**取净买额绝对值最大的那一行作为该票的代表行**，
 * 同时把"上榜原因个数"单独保留成异动强度信号（三个原因同时触发 = 异动比单原因剧烈）。
 * 需要求和的场景必须显式传 policy="sum"，默认永远不求和。
 * 席位明细同理，按营业部名去重取最大，不跨 change_type 相加。
 *
 * ## d1_chg..d30_chg 是天然监督标签，但上榜当日全为 null
 *
 * 东财按日回填，所以任何用到它的地方都必须判 null，且不能把 null 当 0 ——
 * 把 null 当 0 会把"还不知道"算成"次日平收"，直接污染胜率统计。
 */
import type { FactorSpec, LhbRow, LhbSeatRow, PointInTimeView } from "@/lib/contracts";
import { clamp, mean, pnum, pstr, requireCode, round6, evalDate } from "@/lib/factors/util";

export type LhbRowPolicy = "max" | "sum";

export interface CodeFlow {
  code: string;
  netAmt: number;
  buyAmt: number;
  sellAmt: number;
  /** 上榜原因个数 = 异动强度 */
  rowCount: number;
  reasons: string[];
  /** 代表行的 change_type，供归因回查 */
  changeType: string;
  /** 只统计非 null 的后续涨跌幅 */
  d1Chg: number | null;
}

export function aggregateLhbByCode(rows: LhbRow[], policy: LhbRowPolicy = "max"): Map<string, CodeFlow> {
  const out = new Map<string, CodeFlow>();
  for (const r of rows) {
    const cur = out.get(r.code);
    if (cur === undefined) {
      out.set(r.code, {
        code: r.code, netAmt: r.netAmt, buyAmt: r.buyAmt, sellAmt: r.sellAmt,
        rowCount: 1, reasons: [r.explanation], changeType: r.changeType, d1Chg: r.d1Chg,
      });
      continue;
    }
    cur.rowCount++;
    cur.reasons.push(r.explanation);
    if (r.d1Chg !== null) cur.d1Chg = r.d1Chg;
    if (policy === "sum") {
      cur.netAmt += r.netAmt; cur.buyAmt += r.buyAmt; cur.sellAmt += r.sellAmt;
    } else if (Math.abs(r.netAmt) > Math.abs(cur.netAmt)) {
      cur.netAmt = r.netAmt; cur.buyAmt = r.buyAmt; cur.sellAmt = r.sellAmt; cur.changeType = r.changeType;
    }
  }
  return out;
}

export type SeatKind = "机构" | "北向" | "营业部";

/** 机构专用与沪深股通专用不是游资 —— 把它们算进游资净买会得出"游资在扫货"的假结论 */
export function classifySeat(deptName: string): SeatKind {
  if (deptName.includes("股通专用")) return "北向";
  if (deptName.includes("机构专用")) return "机构";
  return "营业部";
}

/**
 * 席位去重：同一营业部会在同一只票的多个上榜原因下重复出现，
 * 取净额绝对值最大的一条。相加同样会重复计钱。
 * 注意 dept_code 对机构席位全是 '0'（migration 003 实测），所以按 dept_name 去重。
 */
export function dedupeSeats(seats: LhbSeatRow[]): LhbSeatRow[] {
  const out = new Map<string, LhbSeatRow>();
  for (const s of seats) {
    const key = `${s.code}|${s.side}|${s.deptName}`;
    const cur = out.get(key);
    if (cur === undefined || Math.abs(s.netAmt) > Math.abs(cur.netAmt)) out.set(key, s);
  }
  return [...out.values()];
}

const V = "1.0.0";

/* ---------------------------- 龙虎榜净买（单票） ---------------------------- */

const 龙虎榜净买: FactorSpec<number | null> = {
  name: "龙虎榜净买", version: V, group: "fund",
  defaults: {},
  fn: ctx => {
    const code = requireCode(ctx.params, "龙虎榜净买");
    const date = evalDate(ctx.view, ctx.params);
    const flow = aggregateLhbByCode(ctx.view.lhb(date)).get(code);
    if (flow === undefined) {
      return {
        name: "龙虎榜净买", version: V, value: null, label: "当日未上榜",
        provenance: "real", confidence: 0, inputs: { 代码: code, 日期: date },
      };
    }
    return {
      name: "龙虎榜净买", version: V, value: round6(flow.netAmt),
      label: flow.netAmt >= 0 ? "净买" : "净卖",
      provenance: "real", confidence: 0.95,
      inputs: {
        代码: code, 日期: date, 上榜原因数: flow.rowCount, 上榜原因: flow.reasons,
        代表行类型: flow.changeType, 买入额: flow.buyAmt, 卖出额: flow.sellAmt,
      },
    };
  },
};

/* ---------------------------- 龙虎榜净买聚类 ---------------------------- */

const 龙虎榜净买聚类: FactorSpec<number | null> = {
  name: "龙虎榜净买聚类", version: V, group: "fund",
  defaults: { 大额阈值: 5e7 },
  fn: ctx => {
    const date = evalDate(ctx.view, ctx.params);
    const rows = ctx.view.lhb(date);
    if (rows.length === 0) {
      // 交易日必然有龙虎榜（几十到上百行）。空 = 没采到，不是"今天没人上榜"
      return {
        name: "龙虎榜净买聚类", version: V, value: null, label: "无龙虎榜数据",
        provenance: "real", confidence: 0, inputs: { 日期: date },
      };
    }
    const big = pnum(ctx.params, "大额阈值", 5e7);
    const flows = [...aggregateLhbByCode(rows).values()];

    const 大额净买 = flows.filter(f => f.netAmt >= big).length;
    const 净买 = flows.filter(f => f.netAmt > 0 && f.netAmt < big).length;
    const 净卖 = flows.filter(f => f.netAmt <= 0 && f.netAmt > -big).length;
    const 大额净卖 = flows.filter(f => f.netAmt <= -big).length;

    // 大额计双份权重：一只 -3 亿的票压过三只 -500 万
    const wBuy = 大额净买 * 2 + 净买;
    const wSell = 大额净卖 * 2 + 净卖;
    const value = round6(wBuy + wSell === 0 ? 50 : 100 * wBuy / (wBuy + wSell));
    return {
      name: "龙虎榜净买聚类", version: V, value,
      label: value >= 65 ? "资金净流入" : value >= 40 ? "多空均衡" : "资金净流出",
      provenance: "real", confidence: 0.9,
      inputs: {
        日期: date, 上榜票数: flows.length, 上榜行数: rows.length,
        大额净买, 净买, 净卖, 大额净卖,
        净买总额: round6(flows.reduce((a, f) => a + f.netAmt, 0)),
      },
    };
  },
};

/* ---------------------------- 游资席位识别 ---------------------------- */

const 游资席位识别: FactorSpec<number> = {
  name: "游资席位识别", version: V, group: "fund",
  defaults: { 胜率阈值: 50 },
  fn: ctx => {
    const code = requireCode(ctx.params, "游资席位识别");
    const date = evalDate(ctx.view, ctx.params);
    const seats = dedupeSeats(ctx.view.lhbSeats(date).filter(s => s.code === code));
    if (seats.length === 0) {
      return {
        name: "游资席位识别", version: V, value: 0, label: "无席位明细",
        provenance: "real", confidence: 0, inputs: { 代码: code, 日期: date },
      };
    }

    const 阈值 = pnum(ctx.params, "胜率阈值", 50);
    const 游资: LhbSeatRow[] = [];
    const 未知: LhbSeatRow[] = [];
    let 机构净买 = 0;
    let 北向净买 = 0;
    for (const s of seats) {
      const kind = classifySeat(s.deptName);
      if (kind === "机构") { 机构净买 += s.netAmt; continue; }
      if (kind === "北向") { 北向净买 += s.netAmt; continue; }
      // riseProb3d 为 null 时不能默认它是游资，也不能默认不是 —— 单独计数并压低置信度
      if (s.riseProb3d === null) { 未知.push(s); continue; }
      if (s.riseProb3d >= 阈值) 游资.push(s);
    }

    const 游资净买 = round6(游资.reduce((a, s) => a + s.netAmt, 0));
    const mags: Array<[string, number]> = [
      ["游资主导", Math.abs(游资净买)], ["机构主导", Math.abs(机构净买)], ["北向主导", Math.abs(北向净买)],
    ];
    const top = mags.reduce((m, x) => (x[1] > m[1] ? x : m), ["混合", 0] as [string, number]);
    const 营业部数 = 游资.length + 未知.length;
    return {
      name: "游资席位识别", version: V, value: 游资净买,
      label: top[1] === 0 ? "混合" : top[0],
      provenance: "real",
      confidence: round6(0.9 * (营业部数 === 0 ? 1 : 1 - 0.5 * 未知.length / 营业部数)),
      inputs: {
        代码: code, 日期: date,
        游资席位: 游资.map(s => s.deptName),
        游资净买, 机构净买: round6(机构净买), 北向净买: round6(北向净买),
        胜率缺失席位数: 未知.length,
        席位总数: seats.length,
        游资胜率: 游资.map(s => s.riseProb3d),
      },
    };
  },
};

/* ------------------------------ 板块净流入 ------------------------------ */

/**
 * 板块净流入。
 *
 * lhb 行里没有板块字段，唯一能拿到 code→板块 映射的地方是 zt_pool.sector。
 * 这意味着映射**只覆盖当日涨停过的票**，覆盖率写进 inputs 并据此折算置信度 ——
 * 覆盖率 60% 的板块净流入和覆盖率 100% 的不是一个东西，不能同权使用。
 */
const 板块净流入: FactorSpec<number | null> = {
  name: "板块净流入", version: V, group: "fund",
  defaults: { 板块: "" },
  fn: ctx => {
    const date = evalDate(ctx.view, ctx.params);
    const want = pstr(ctx.params, "板块", "");
    const rows = ctx.view.lhb(date);
    const flows = [...aggregateLhbByCode(rows).values()];
    const sectorOf = new Map<string, string>();
    for (const z of ctx.view.ztPool(date)) if (z.sector !== null) sectorOf.set(z.code, z.sector);

    const covered = flows.filter(f => sectorOf.has(f.code));
    const coverage = flows.length === 0 ? 0 : covered.length / flows.length;
    if (covered.length === 0) {
      return {
        name: "板块净流入", version: V, value: null,
        label: "无板块映射（涨停池缺快照）",
        provenance: "real", confidence: 0,
        inputs: { 日期: date, 上榜票数: flows.length, 板块映射覆盖率: round6(coverage) },
      };
    }

    const bySector = new Map<string, { net: number; codes: string[] }>();
    for (const f of covered) {
      const s = sectorOf.get(f.code)!;
      const cur = bySector.get(s) ?? { net: 0, codes: [] };
      cur.net += f.netAmt; cur.codes.push(f.code);
      bySector.set(s, cur);
    }

    const picked = want !== ""
      ? [want, bySector.get(want) ?? { net: 0, codes: [] }] as const
      : [...bySector.entries()].sort((a, b) => b[1].net - a[1].net || (a[0] < b[0] ? -1 : 1))[0];

    return {
      name: "板块净流入", version: V, value: round6(picked[1].net),
      label: picked[0],
      provenance: "real",
      confidence: round6(0.9 * clamp(coverage, 0, 1)),
      inputs: {
        日期: date, 板块: picked[0], 成分票: picked[1].codes,
        板块映射覆盖率: round6(coverage),
        全部板块: [...bySector.entries()].map(([s, v]) => ({ 板块: s, 净额: round6(v.net), 票数: v.codes.length })),
      },
    };
  },
};

/* ---------------------------- 龙虎榜次日兑现 ---------------------------- */

/**
 * 上榜后次日涨跌幅均值 —— 自校准闭环的天然监督标签（spec §11）。
 * d1Chg 在上榜当日全为 null，随后回填，所以这里只对非 null 求均值，
 * 且样本量与缺标签数都要报出来。
 */
const 龙虎榜次日兑现: FactorSpec<number | null> = {
  name: "龙虎榜次日兑现", version: V, group: "fund",
  defaults: {},
  fn: ctx => {
    const date = evalDate(ctx.view, ctx.params);
    const rows = ctx.view.lhb(date);
    const withLabel = rows.filter(r => r.d1Chg !== null);
    if (withLabel.length === 0) {
      return {
        name: "龙虎榜次日兑现", version: V, value: null,
        label: rows.length === 0 ? "无龙虎榜数据" : "后续涨跌幅尚未回填",
        provenance: "real", confidence: 0,
        inputs: { 日期: date, 有效样本: 0, 缺标签样本: rows.length },
      };
    }
    const avg = round6(mean(withLabel.map(r => r.d1Chg as number)));
    return {
      name: "龙虎榜次日兑现", version: V, value: avg,
      label: avg > 0 ? "上榜后走强" : "上榜后走弱",
      provenance: "real",
      // 回填不全时置信度按已回填比例折算
      confidence: round6(0.9 * withLabel.length / rows.length),
      inputs: {
        日期: date, 有效样本: withLabel.length, 缺标签样本: rows.length - withLabel.length,
      },
    };
  },
};

export const FUND_FACTORS: FactorSpec<any>[] = [
  龙虎榜净买, 龙虎榜净买聚类, 游资席位识别, 板块净流入, 龙虎榜次日兑现,
];

/** 供策略层直接用的聚合视图（不经因子包装） */
export function lhbFlows(view: PointInTimeView, date: string, policy: LhbRowPolicy = "max"): CodeFlow[] {
  return [...aggregateLhbByCode(view.lhb(date), policy).values()];
}
