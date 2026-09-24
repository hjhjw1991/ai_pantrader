import type Database from "better-sqlite3";
import type { StrategyConfig } from "@/lib/contracts/strategy";
import { unavailable, type Avail } from "@/lib/ui/derive";
import { createSqliteView } from "@/lib/pit/sqlite-view";
import { defaultRegistry } from "@/lib/factors";
import { makeRunner, resolveDate } from "@/lib/strategy/engine";
import { macd, crosses } from "@/lib/factors/structure";

/**
 * K 线图的数据：前复权 K 线、日线 MACD、日 / 周线金叉死叉、结构位、M 顶 W 底。
 *
 * 口径与因子层一致，不另算一套：
 *   - 指标在后复权价上算（除权缺口不会造出假交叉），画的时候除以最新一根的复权因子 = 前复权，
 *     最新价与券商 App 对得上
 *   - 结构位与 M 顶 W 底直接跑因子，图上画的就是引擎看到的那个值
 *   - 周线只用已完成的周；周线交叉标在那一周最后一个交易日上
 */

type Db = Database.Database;

export interface ChartBar { date: string; o: number; h: number; l: number; c: number; vol: number }
export interface ChartCross { date: string; kind: "金叉" | "死叉"; aboveZero: boolean }
export interface ChartData {
  code: string;
  name: string | null;
  bars: ChartBar[];
  macd: Array<{ date: string; dif: number; dea: number; hist: number }>;
  dailyCrosses: ChartCross[];
  weeklyCrosses: ChartCross[];
  structure: { resistance: number | null; support: number | null; label: string } | null;
  pattern: { kind: string; state: string; neckline: number; breakDate: string | null; points: Array<{ role: string; date: string; price: number }> } | null;
  atr: number | null;
  /** 复权口径说明；最新复权因子缺失时如实说 */
  note: string;
}

const WARMUP = 120;
const r4 = (x: number) => Math.round(x * 1e4) / 1e4;
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

export function chartData(db: Db, code: string, n: number, asOf: string, config: StrategyConfig): Avail<ChartData> {
  try {
    const view = createSqliteView(db, asOf);
    const hfq = view.adjBars(code, n + WARMUP);
    if (hfq.length === 0) return { available: true, ...empty(code, "kline_daily 里没有这只票的日线") };
    const f = hfq[hfq.length - 1].adjFactor;
    if (!(f > 0)) return unavailable(`${code} 最新一根日线没有复权因子，无法换算前复权价`);

    const m = macd(hfq.map(b => b.c));
    const start = Math.max(0, hfq.length - n);
    const dates = hfq.map(b => b.date);
    const bars = hfq.slice(start).map(b => ({
      date: b.date, o: r4(b.o / f), h: r4(b.h / f), l: r4(b.l / f), c: r4(b.c / f), vol: b.vol,
    }));
    const macdRows = hfq.slice(start).map((b, j) => {
      const i = start + j;
      return { date: b.date, dif: r4(m.dif[i] / f), dea: r4(m.dea[i] / f), hist: r4(m.hist[i] / f) };
    });
    // 预热段里的交叉不画：EMA 从首值起步，前几十根的 DIF/DEA 还没收敛
    const dailyCrosses = crosses(m.dif, m.dea).filter(e => e.i >= start && e.i >= 35)
      .map(e => ({ date: dates[e.i], kind: e.kind, aboveZero: m.dif[e.i] > 0 }));

    const from = bars[0].date;
    const wk = view.periodBars(code, "W", 150);
    const wm = macd(wk.map(b => b.c));
    const weeklyCrosses = crosses(wm.dif, wm.dea).filter(e => e.i >= 35 && wk[e.i].date >= from)
      .map(e => ({ date: snapToBar(dates, wk[e.i].date), kind: e.kind, aboveZero: wm.dif[e.i] > 0 }))
      .filter(e => e.date !== null) as ChartCross[];

    const run = makeRunner(defaultRegistry, config, view, resolveDate(view), () => {});
    const st = run.run("结构位", { code });
    const pt = run.run("M顶W底", { code });
    const at = run.run("ATR", { code });
    const si = (st?.inputs ?? {}) as Record<string, unknown>;
    const pi = (pt?.inputs ?? {}) as Record<string, any>;
    const name = (db.prepare("SELECT name FROM security WHERE code = ?").get(code) as { name?: string } | undefined)?.name ?? null;

    return {
      available: true, code, name, bars, macd: macdRows, dailyCrosses, weeklyCrosses,
      structure: st === null || st.confidence === 0 ? null
        : { resistance: num(si["阻力"]), support: num(si["支撑"]), label: st.label ?? "" },
      pattern: pt !== null && typeof pi["形态"] === "string"
        ? { kind: pi["形态"], state: pi["状态"], neckline: pi["颈线"], breakDate: pi["破颈日"] ?? null,
            points: (pi["形态点"] ?? []).map((x: any) => ({ role: x.角色, date: x.日期, price: x.价格 })) }
        : null,
      atr: num((at?.inputs ?? {})["ATR"]),
      note: "前复权（以最新一根为基准）；MACD 在后复权价上算，除权缺口不会造出假交叉",
    };
  } catch (e) {
    return unavailable(`K 线数据读取失败：${(e as Error).message}`);
  }
}

/** 周线日期可能落在非交易日（周线表按周末日期记），吸附到不晚于它的最后一根日线 */
function snapToBar(dates: string[], d: string): string | null {
  let lo = 0, hi = dates.length - 1, ans: string | null = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (dates[mid] <= d) { ans = dates[mid]; lo = mid + 1; } else hi = mid - 1;
  }
  return ans;
}

function empty(code: string, note: string): ChartData {
  return { code, name: null, bars: [], macd: [], dailyCrosses: [], weeklyCrosses: [], structure: null, pattern: null, atr: null, note };
}
