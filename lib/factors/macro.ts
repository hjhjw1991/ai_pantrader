/**
 * 外围传导（spec §8）：A50 / 费半 / 金油 → 今天开盘方向。
 *
 * 现实约束：macro 表现在是**空的**，数据从上线那天才开始攒，没有历史。
 * 所以这个因子最重要的行为不是算得准，而是**在没有数据时诚实地说没有**：
 *   - 不抛异常（回测会因为一个空表整段跳过）
 *   - 不把读数当 0（0 会被择时读成"外围中性"，等于凭空给了一个中性结论）
 *   → value = null + confidence = 0，让上层把它列进低置信因子清单（spec §10.5）。
 *
 * 符号名也还没定 —— 采集器尚未实现，东财/新浪对 A50、费半的代码写法不一样，
 * 所以标的映射做成参数，接入时改配置而不是改因子（改因子要升 version）。
 */
import type { FactorSpec, MacroRow, PointInTimeView } from "@/lib/contracts";
import { pnum, pobj, round6 } from "@/lib/factors/util";

export const DEFAULT_MACRO_SYMBOLS = {
  A50: "A50", 费半: "SOX", 黄金: "XAU", 原油: "OIL",
} as const;

/**
 * 权重与符号。黄金取**负权重**：金价走强是避险行为，对 A 股风险偏好是压制，
 * 与 A50/费半 同向相加会把 risk_off 抵消掉。
 */
export const DEFAULT_MACRO_WEIGHTS: Record<string, number> = {
  A50: 0.45, 费半: 0.35, 黄金: -0.1, 原油: 0.1,
};

interface Reading { key: string; symbol: string; pct: number; ts: string }

function readLatest(view: PointInTimeView, symbol: string, n: number): MacroRow | null {
  const rows = view.macro(symbol, n);
  if (rows.length === 0) return null;
  // macro(symbol, n) 约定升序返回最近 n 条，取最后一条 = 最新
  return rows[rows.length - 1];
}

const 外围传导: FactorSpec<number | null> = {
  name: "外围传导", version: "1.0.0", group: "env",
  defaults: {
    标的: { ...DEFAULT_MACRO_SYMBOLS },
    权重: { ...DEFAULT_MACRO_WEIGHTS },
    回溯条数: 3,
    risk_off阈值: -1,
    risk_on阈值: 1,
  },
  fn: ctx => {
    const symbols = pobj(ctx.params, "标的");
    const weights = pobj(ctx.params, "权重");
    const n = pnum(ctx.params, "回溯条数", 3);

    const got: Reading[] = [];
    const missing: string[] = [];
    for (const [key, sym] of Object.entries(symbols)) {
      if (typeof sym !== "string" || sym.length === 0) continue;
      const row = readLatest(ctx.view, sym, n);
      if (row === null) { missing.push(sym); continue; }
      got.push({ key, symbol: sym, pct: row.pct, ts: row.ts });
    }

    if (got.length === 0) {
      return {
        name: "外围传导", version: "1.0.0",
        value: null, label: "外围数据未积累（macro 上线起攒，无历史）",
        provenance: "real", confidence: 0,
        inputs: { 缺失标的: missing, 已读标的: [] },
      };
    }

    // 只对拿到数据的标的归一化。缺 A50 时不把它当 0，而是让费半/金油顶上，
    // 同时按"拿到多少权重"折算置信度。
    const wOf = (key: string) => {
      const w = weights[key];
      return typeof w === "number" && Number.isFinite(w) ? w : 0;
    };
    const absTotal = Object.keys(symbols).reduce((a, k) => a + Math.abs(wOf(k)), 0);
    const absGot = got.reduce((a, r) => a + Math.abs(wOf(r.key)), 0);
    const raw = got.reduce((a, r) => a + wOf(r.key) * r.pct, 0);
    const value = absGot === 0 ? 0 : round6(raw / absGot);

    const off = pnum(ctx.params, "risk_off阈值", -1);
    const on = pnum(ctx.params, "risk_on阈值", 1);
    // 满数据也只给 0.8：外围与 A 股经常脱钩（2026-07-14 费半跌而 A 股 PCB 独立走强），
    // 这个因子天生不该被当成硬约束。
    const coverage = absTotal === 0 ? 0 : absGot / absTotal;

    return {
      name: "外围传导", version: "1.0.0", value,
      label: value <= off ? "risk_off" : value >= on ? "risk_on" : "中性",
      provenance: "real",
      confidence: round6(0.8 * coverage),
      inputs: {
        读数: got.map(r => ({ 标的: r.key, 符号: r.symbol, 涨幅: r.pct, 时间: r.ts })),
        缺失标的: missing,
        权重覆盖率: round6(coverage),
      },
    };
  },
};

export const MACRO_FACTORS: FactorSpec<any>[] = [外围传导];
