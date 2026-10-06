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

/**
 * 瞬时故障判定。判据见 function isTransientError 处的注释。
 *
 * 放在这里而不是 replay.ts：book 需要它做**逐变体**重试，而 replay 本来就 import book，
 * 反过来 import 会成环。
 */
const TRANSIENT = /SQLITE_IOERR|disk I\/O error|SQLITE_BUSY|SQLITE_LOCKED|SQLITE_CANTOPEN/i;

/**
 * 单次读写出错的故障，不是逻辑错误。
 *
 * 实测形态：回放跑着跑着某个变体突然报 `disk I/O error` / `database is locked`，
 * **同一个日子单独重跑又完全正常** —— 这是长事务扫 3.7 GB 库时，与 daemon 并发
 * 读写 WAL 撞上的瞬时冲突。这类失败必须重试；但要跟"槽位抛错"区分开，
 * 真 bug 不能靠重试掩盖过去。
 */
export function isTransientError(e: unknown): boolean {
  return TRANSIENT.test((e as Error)?.message ?? "");
}

/** 同步睡：better-sqlite3 是同步 API，这里没有 await 可用，只能用 Atomics 让出 */
export function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

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

/**
 * 新增一个变体（不改代码也能加组合）。槽名必须都已注册 —— 配错的组合每天抛错、一条样本都攒不下，
 * 却会一直占着一个位置，要在登记时就拦下。
 * id 一经登记不能改、不能复用：要调参数就新开一个 id，旧的退役。
 */
export function addVariant(db: Db, d: VariantDef): void {
  if (!/^[\w+.\-]+$/.test(d.id)) throw new Error(`变体 id 只能用字母数字与 _ + . -：${d.id}`);
  const s = d.slots as Record<string, any>;
  for (const [kind, choice] of Object.entries(s)) {
    const list = Array.isArray(choice) ? choice : [choice];
    if (kind === "候选源" && list.length === 0) throw new Error("候选源不可为空数组");
    for (const c of list) {
      if (typeof c?.用 !== "string" || defaultSlotRegistry.get(kind as any, c.用) === undefined) {
        const 可选 = defaultSlotRegistry.list(kind as any).map(x => x.name).join(" / ");
        throw new Error(`槽位未注册：${kind} "${c?.用}"（已注册：${可选 === "" ? "无（槽名写错了？）" : 可选}）`);
      }
    }
  }
  const r = db.prepare(
    `INSERT OR IGNORE INTO shadow_variant (id, name, slot_config, note, status, created_at) VALUES (?, ?, ?, ?, 'active', ?)`
  ).run(d.id, d.name, JSON.stringify(d.slots), d.note, shanghaiTs());
  if (r.changes === 0) throw new Error(`变体 ${d.id} 已存在（退役的也算）：id 不能复用，换一个`);
}

/** 退役：停止每天出信号，已有样本保留。baseline 不能退 —— 它是所有比较的锚 */
export function retireVariant(db: Db, id: string, incumbent: string | null = null): void {
  if (id === "baseline") throw new Error("baseline 不能退役：它是对照组");
  if (id === incumbent) throw new Error(`${id} 是当前正式策略用的组合，不能退役（先切走或回滚）`);
  const r = db.prepare(
    "UPDATE shadow_variant SET status = 'retired', retired_at = ? WHERE id = ? AND status = 'active'"
  ).run(shanghaiTs(), id);
  if (r.changes === 0) throw new Error(`变体 ${id} 不存在或已退役`);
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

  /** 单变体的"算 + 写"。抽成闭包是为了外面那层瞬时故障重试能重跑它 */
  const recordOne = (v: ActiveVariant) => {
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
  };

  for (const v of variants) {
    if (has.get(v.id, o.source, o.baseDate)) { out.skipped.push(v.id); continue; }
    try {
      /**
       * 瞬时故障要重试，不只整天层面 —— 这里是**逐变体** catch 的那一层。
       *
       * 2026-10-06 踩到：一次从零重算里，6 天各有若干变体"失败"，日志看着像策略 bug，
       * 单独重跑同一天却全部正常。真正的差别是这次 daemon 同时在写库。
       * 只在整天层面重试（replay.ts 那边）兜不住这一层：某个变体在算到一半时
       * 读失败，就会被当成永久失败记掉，而它本来重算一次就能好。
       */
      let lastErr: unknown = null;
      for (let attempt = 1; attempt <= 3; attempt++) {
        try { recordOne(v); lastErr = null; break; }
        catch (e) {
          lastErr = e;
          if (!isTransientError(e)) throw e;
          sleepSync(1500 * attempt);
        }
      }
      if (lastErr !== null) throw lastErr;
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
