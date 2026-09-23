/**
 * 影子盘台账：变体登记、每日并行出信号、夜间结算。
 *
 * 所有变体吃**同一份输入**（同一个视图时点、同一份策略 YAML、同一份行业映射），
 * 只有槽位组合不同。输入里任何一处不同，比出来的差异就不再只是"策略的差异"。
 *
 * 影子盘只评估**新开仓候选**，不看持仓：持仓动作取决于用户真实的仓位与成本，
 * 每套变体的"持仓"都不一样却又都是假的，拿它们比没有意义。
 */
import type { Db } from "@/lib/db";
import type { DailyBar, Phase, SlotConfig, StrategyConfig } from "@/lib/contracts";
import { createSqliteView } from "@/lib/pit/sqlite-view";
import { defaultRegistry } from "@/lib/factors";
import { createV2Engine, defaultSlotRegistry } from "@/lib/strategy/v2";
import { DEFAULT_CONSTRAINTS } from "@/lib/contracts/backtest";
import { shanghaiTs } from "@/lib/data/clock";
import { DEFAULT_VARIANTS, type VariantDef } from "@/lib/shadow/variants";
import { settleShadow } from "@/lib/shadow/settle";

/** 持有期。与正式台账的 PLAN_EVAL_HORIZON 一致，两本账的"5 天"是同一个 5 天 */
export const SHADOW_HORIZON = 5;

export interface ActiveVariant { id: string; name: string; slots: SlotConfig }

/** 首次运行时把默认变体登记进表。已有的不动 —— 变体一经产出样本，定义就不能被代码悄悄改掉 */
export function seedVariants(db: Db, defs: VariantDef[] = DEFAULT_VARIANTS): number {
  const ins = db.prepare(
    `INSERT OR IGNORE INTO shadow_variant (id, name, slot_config, note, status, created_at)
     VALUES (?, ?, ?, ?, 'active', ?)`
  );
  let n = 0;
  db.transaction(() => {
    for (const d of defs) n += ins.run(d.id, d.name, JSON.stringify(d.slots), d.note, shanghaiTs()).changes;
  })();
  return n;
}

export function activeVariants(db: Db): ActiveVariant[] {
  return (db.prepare(
    "SELECT id, name, slot_config FROM shadow_variant WHERE status = 'active' ORDER BY id"
  ).all() as Array<{ id: string; name: string; slot_config: string }>)
    .map(r => ({ id: r.id, name: r.name, slots: JSON.parse(r.slot_config) as SlotConfig }));
}

export interface ShadowDayOpts {
  /** 发出日（live = 计划当天） */
  decidedOn: string;
  /** 基准日：视图能看到的最后一个收盘日 */
  baseDate: string;
  asOf: string;
  phase: Phase;
  config: StrategyConfig;
  source: "live" | "replay";
  sectorOf?: (code: string) => string | null;
  sectorMapAt?: string;
  /** 测试注入用；缺省用默认注册表 */
  engineFor?: (slots: SlotConfig) => (input: any) => any;
  variants?: ActiveVariant[];
}

export interface ShadowDayResult {
  variants: number;
  recorded: number;
  /** 已经记过、本次跳过的变体 */
  skipped: string[];
  failed: Array<{ variant: string; error: string }>;
}

/**
 * 一天的影子盘：每个在跑的变体各出一张卡，把买入候选记进 shadow_pred。
 *
 * 幂等：同一变体、同一来源、同一基准日已经有记录就跳过（job 重跑、唤醒补偿都会再调一次）。
 * 单个变体抛错不拖累其他变体 —— 一个新槽有 bug，不该让对照组那天也没样本。
 */
export function runShadowDay(db: Db, o: ShadowDayOpts): ShadowDayResult {
  const variants = o.variants ?? activeVariants(db);
  const view = createSqliteView(db, o.asOf);
  const lock = JSON.stringify(defaultSlotRegistry.lock());
  const make = o.engineFor ?? ((slots: SlotConfig) => {
    const e = createV2Engine({ registry: defaultRegistry, slots: defaultSlotRegistry });
    return (input: any) => e({ ...input, slotConfig: slots });
  });
  const has = db.prepare(
    "SELECT 1 FROM shadow_pred WHERE variant_id = ? AND source = ? AND base_date = ? LIMIT 1"
  );
  const ins = db.prepare(
    `INSERT OR IGNORE INTO shadow_pred
       (id, variant_id, source, base_date, decided_on, code, name, account,
        trigger_px, stop_px, target_px, rr_ratio, size, score, gear, stage,
        strategy_id, strategy_ver, slot_lock, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );

  const out: ShadowDayResult = { variants: variants.length, recorded: 0, skipped: [], failed: [] };
  for (const v of variants) {
    if (has.get(v.id, o.source, o.baseDate)) { out.skipped.push(v.id); continue; }
    try {
      const card = make(v.slots)({
        view, config: o.config, phase: o.phase, positions: [],
        ...(o.sectorOf ? { sectorOf: o.sectorOf } : {}),
        ...(o.sectorMapAt ? { sectorMapAt: o.sectorMapAt } : {}),
      });
      const buys = (card.candidates as any[]).filter(c => c.action === "买入" && typeof c.triggerPx === "number");
      db.transaction(() => {
        for (const c of buys) {
          out.recorded += ins.run(
            `${o.baseDate}:${v.id}:${o.source}:${c.code}`, v.id, o.source, o.baseDate, o.decidedOn,
            c.code, c.name ?? null, c.account, c.triggerPx, c.stopPx ?? null,
            typeof c.targetPx === "number" ? c.targetPx : null,
            typeof c.rrRatio === "number" ? c.rrRatio : null,
            c.size, typeof c.score === "number" ? c.score : null,
            card.env.gear, card.stage ?? null, o.config.id, o.config.version ?? null, lock, shanghaiTs(),
          ).changes;
        }
        // 当天一只都没有也要留痕：否则"这个变体那天判了防守、0 候选"和"那天没跑"分不开，
        // 幂等检查也会让它每次重跑。用一条哨兵行（trigger_px = 0、size = 0，结算时跳过）
        if (buys.length === 0) {
          ins.run(`${o.baseDate}:${v.id}:${o.source}:-`, v.id, o.source, o.baseDate, o.decidedOn,
            "-", null, "-", 0, null, null, null, 0, null, card.env.gear, card.stage ?? null,
            o.config.id, o.config.version ?? null, lock, shanghaiTs());
        }
      })();
    } catch (e) {
      out.failed.push({ variant: v.id, error: (e as Error).message });
    }
  }
  return out;
}

/** 某天全市场日线少于这么多行，视为那天的日线还没采全 */
const MIN_MARKET_BARS = 1000;

export interface SettleResult { settled: number; untriggered: number; pending: number }

/**
 * 结算到期的影子预测：基准日之后已走过持有期的，按止损 / 目标价模拟离场。
 * "待定"不落表，下一晚重试。
 */
export function settleShadowPending(db: Db, asOf: string): SettleResult {
  const preds = db.prepare(
    `SELECT p.id, p.code, p.base_date, p.trigger_px, p.stop_px, p.target_px
       FROM shadow_pred p LEFT JOIN shadow_outcome o ON o.pred_id = p.id
      WHERE o.pred_id IS NULL AND p.code != '-' AND p.base_date < ?
      ORDER BY p.base_date, p.id`
  ).all(asOf) as Array<{ id: string; code: string; base_date: string; trigger_px: number; stop_px: number | null; target_px: number | null }>;
  const barsAfter = db.prepare(
    `SELECT code, date, o, h, l, c, vol, amount, COALESCE(adj_factor, 1.0) AS adj_factor
       FROM kline_daily WHERE code = ? AND date > ? AND date <= ? ORDER BY date LIMIT ?`
  );
  const ins = db.prepare(
    `INSERT OR IGNORE INTO shadow_outcome
       (pred_id, status, entry_date, entry_px, exit_date, exit_px, exit_reason,
        gross_pct, net_pct, mfe_pct, mae_pct, note, settled_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const baseAdj = db.prepare("SELECT COALESCE(adj_factor, 1.0) AS f FROM kline_daily WHERE code = ? AND date = ?");
  const nextDay = db.prepare(
    "SELECT date FROM trading_calendar WHERE is_open = 1 AND date > ? ORDER BY date LIMIT 1"
  );
  const marketBars = db.prepare("SELECT COUNT(*) AS n FROM kline_daily WHERE date = ?");
  const r: SettleResult = { settled: 0, untriggered: 0, pending: 0 };
  for (const p of preds) {
    /**
     * 成交日必须是基准日的**下一个交易日**。那天这只票没有 K 线有两种原因：
     *   全市场都没有 → 日线还没采到，待定
     *   只有它没有   → 停牌，买不进，未触发
     * 不分开的话，停牌票会被当成"下一根 K 线那天成交"，等于给了它一个不存在的买点。
     */
    const next = (nextDay.get(p.base_date) as { date: string } | undefined)?.date ?? null;
    if (next === null || next > asOf) { r.pending++; continue; }
    const bars = (barsAfter.all(p.code, p.base_date, asOf, SHADOW_HORIZON + 12) as any[])
      .map(b => ({ code: b.code, date: b.date, o: b.o, h: b.h, l: b.l, c: b.c, vol: b.vol, amount: b.amount, adjFactor: b.adj_factor }) as DailyBar);
    if (bars.length === 0 || bars[0].date !== next) {
      const n = Number((marketBars.get(next) as { n: number }).n);
      if (n < MIN_MARKET_BARS) { r.pending++; continue; }
      ins.run(p.id, "未触发", next, null, null, null, null, null, null, null, null, "成交日停牌", shanghaiTs());
      r.untriggered++;
      continue;
    }
    const s = settleShadow(
      { triggerPx: p.trigger_px, stopPx: p.stop_px, targetPx: p.target_px }, bars,
      {
        horizon: SHADOW_HORIZON, slippage: DEFAULT_CONSTRAINTS.slippage, feeRate: DEFAULT_CONSTRAINTS.feeRate,
        ...(() => { const f = (baseAdj.get(p.code, p.base_date) as { f: number } | undefined)?.f; return f === undefined ? {} : { baseAdjFactor: f }; })(),
      },
    );
    if (s.status === "待定") { r.pending++; continue; }
    ins.run(p.id, s.status, s.entryDate, s.entryPx, s.exitDate, s.exitPx, s.exitReason,
      s.grossPct, s.netPct, s.mfePct, s.maePct, s.note, shanghaiTs());
    if (s.status === "未触发") r.untriggered++; else r.settled++;
  }
  return r;
}
