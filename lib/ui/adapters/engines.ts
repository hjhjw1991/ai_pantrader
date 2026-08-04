import type Database from "better-sqlite3";
import type { Phase, SignalCard, StrategyConfig } from "@/lib/contracts/strategy";
import type { BacktestReport, Constraints } from "@/lib/contracts/backtest";
import { unavailable, type Avail } from "@/lib/ui/derive";
import { createSqliteView, universeQuality, type UniverseQuality } from "@/lib/pit/sqlite-view";
import { createStrategyEngine } from "@/lib/strategy/engine";
import { defaultRegistry } from "@/lib/factors";
import { runBacktest as replay } from "@/lib/backtest";
import { positions as loadPositions } from "@/lib/ui/queries";

/**
 * 信号引擎 / 回测器适配器。
 *
 * 前端不实现任何决策逻辑：档位、候选、过滤、约束全部来自 lib/strategy + lib/factors
 * + lib/backtest。这里只做三件事 —— 组装 PIT 视图、传入配置与持仓、把异常翻译成
 * 页面能渲染的空态。任何一层抛错时**不返回半成品信号卡**：半份候选池比空白危险。
 */

type Db = Database.Database;

const engine = createStrategyEngine({ registry: defaultRegistry });

/** 时段按 Asia/Shanghai 的钟点判，不用 UTC —— 收盘后会被算成前一天的盘中 */
export function phaseAt(now: Date): Phase {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(now);
  const m = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  const mins = (Number(m.hour) % 24) * 60 + Number(m.minute);
  if (mins < 9 * 60 + 15) return "盘前";
  if (mins <= 15 * 60 + 5) return "盘中";
  return "盘后";
}

export interface SignalCardResult {
  card: SignalCard;
  phase: Phase;
  asOf: string;
  /** 幸存者过滤的实际覆盖率：list_date 未知的票逃过了过滤，折扣要能量化（spec §10.2） */
  universe: UniverseQuality;
}

/**
 * 当日信号卡。
 *
 * asOf 由调用方给（页面传当前时刻），不在这里取 Date.now() ——
 * 因子层禁用 Date.now，视图时点必须是显式的一个值，否则同一次渲染里
 * 不同因子可能看到不同的"现在"。
 */
export function todaySignalCard(
  db: Db,
  asOf: string,
  config: StrategyConfig
): Avail<SignalCardResult> {
  try {
    const view = createSqliteView(db, asOf);
    const phase = phaseAt(new Date(asOf));
    const pos = loadPositions(db).map((p) => ({
      account: p.account,
      code: p.code,
      cost: p.cost,
      qty: p.qty,
      stopPx: p.stopPx,
    }));
    const card = engine({ view, config, phase, positions: pos });
    return { available: true, card, phase, asOf, universe: universeQuality(db, asOf) };
  } catch (e) {
    return unavailable(
      `信号引擎执行失败：${(e as Error).message}`,
      "多半是当日截面数据缺失（zt_pool / sector_rank / macro）或视图越界。缺口明细见设置页；此处不显示部分结果 —— 半份候选池比空白危险"
    );
  }
}

export interface BacktestRunInput {
  from: string;
  to: string;
  config: StrategyConfig;
  initialCash: number;
  constraints?: Constraints;
  /** 报告信封时间戳，必须外部注入：重放路径内不许出现 Date.now()（spec §17 断言 4） */
  generatedAt: string;
}

/**
 * 跑一次回测。
 *
 * 约束一律用回测层的默认值（T+1 / 涨停买不进 / 跌停卖不出 / 停牌不成交 / 滑点 / 费率）——
 * 前端不提供关闭开关：关掉任何一条都会让回测虚高，而虚高的成绩决定投多少钱。
 */
export function runBacktest(db: Db, i: BacktestRunInput): Avail<{ report: BacktestReport }> {
  try {
    const out = replay({
      from: i.from,
      to: i.to,
      viewFactory: (asOf: string) => createSqliteView(db, asOf),
      strategy: engine,
      config: i.config,
      initialCash: i.initialCash,
      ...(i.constraints ? { constraints: i.constraints } : {}),
      generatedAt: i.generatedAt,
    });
    return { available: true, report: out.report };
  } catch (e) {
    return unavailable(
      `回测失败：${(e as Error).message}`,
      "不返回部分净值曲线 —— 一条不完整的净值曲线会被当成策略成绩读"
    );
  }
}
