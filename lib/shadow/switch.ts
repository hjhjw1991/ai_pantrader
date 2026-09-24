/**
 * 影子盘毕业与策略切换。
 *
 * 口径（用户 2026-09-23 选定，见 memory shadow-book-decisions）：
 *   毕业 = 实盘影子样本 ≥ 30 笔已结算、≥ 20 个交易日，期望显著优于在任者（Welch t ≥ 2），
 *          最大回撤不比在任者差。回放样本一概不算
 *   切换 = 前 2 次由人批，之后自动。回滚之后重新数：人连续批过 2 次才恢复自动
 *
 * "在任者"不是固定的 baseline，而是当前正式策略用的那套组合：
 * 第一次切换之前它就是 baseline；切过之后，下一个挑战者要赢的是新的在任者 ——
 * 否则一个只比 baseline 好、却比在任者差的组合也能"毕业"，把正式策略换差。
 *
 * 两边只在**共同的、已结清的基准日**上比：同一段行情、同一批日子，
 * 差异才只是打法的差异。挑战者晚上线两个月，拿它的两个月去比在任者的半年是不公平的。
 *
 * 样本还要按槽实现的版本过滤：槽改了版本，旧样本是旧实现跑出来的，不该算到新实现头上。
 *
 * 切换落在策略 YAML 的 `槽位:` 段（D7：YAML 是唯一真相源），并升 patch 版本号；
 * strategy_switch 只记证据与经过。
 */
import fs from "node:fs";
import type { Db } from "@/lib/db";
import type { SlotConfig } from "@/lib/contracts";
import { canonicalJson } from "@/lib/backtest/hash";
import { defaultSlotRegistry, BASELINE_CHOICE } from "@/lib/strategy/v2";
import { activeStrategyPath } from "@/lib/strategy/registry";
import { validateStrategyYaml } from "@/lib/strategy/schema";
import { writeSlotsInText, writeParamInText, bumpPatch } from "@/lib/strategy/loader";
import { snapshotStrategy, hasSnapshot } from "@/lib/ledger/strategy-snapshot";
import { pushNotification } from "@/lib/ui/notify";
import { shanghaiTs } from "@/lib/data/clock";
import { maxDrawdown, welch, type Trade } from "@/lib/shadow/stats";

export const GRADUATION = { minSettled: 30, minDays: 20, minT: 2 } as const;
/** 前几次切换必须人批 */
export const MANUAL_APPROVALS_BEFORE_AUTO = 2;
/** 被否决或被回滚的变体，要再攒这么多个实盘交易日的新样本才重新参评 */
export const RECONSIDER_AFTER_DAYS = 20;

export interface SwitchOpts {
  /** 策略文件路径；缺省用当前生效的那份 */
  path?: string;
  /** 槽实现版本表；缺省用默认注册表 */
  lock?: Record<string, string>;
  now?: string;
}

/* ------------------------------ 当前策略 ------------------------------ */

interface Current { path: string; raw: string; id: string; version: string; slots: SlotConfig; slotsKey: string }

function readCurrent(o: SwitchOpts): Current {
  const path = o.path ?? activeStrategyPath();
  if (path === null) throw new Error("没有生效的策略文件");
  const raw = fs.readFileSync(path, "utf8");
  const r = validateStrategyYaml(raw, path);
  if (!r.ok) throw new Error(`策略文件校验不过：${r.issues.map(i => i.message).join("；")}`);
  const slots = (r.config.槽位 ?? {}) as SlotConfig;
  return { path, raw, id: r.config.id, version: r.config.version, slots, slotsKey: canonicalJson(slots) };
}

/** 当前正式策略用的是哪套变体。YAML 的槽位被手改成一套没登记过的组合时为 null —— 那就没有可比的对象 */
export function incumbentOf(db: Db, slotsKey: string): string | null {
  const rows = db.prepare("SELECT id, slot_config FROM shadow_variant ORDER BY id").all() as Array<{ id: string; slot_config: string }>;
  return rows.find(r => canonicalJson(JSON.parse(r.slot_config)) === slotsKey)?.id ?? null;
}

/* ------------------------------ 毕业判定 ------------------------------ */

const SINGLE = ["择时器", "主线识别器", "评估器", "离场器"] as const;

/** 一套组合实际用到的槽（没写的按 baseline 补齐），形如 "择时器:五段状态机" */
export function slotKeys(slots: SlotConfig): string[] {
  const s = slots as Record<string, any>;
  const b = BASELINE_CHOICE as Record<string, any>;
  return [
    ...SINGLE.map(k => `${k}:${(s[k] ?? b[k]).用}`),
    ...((s.候选源 ?? b.候选源) as Array<{ 用: string }>).map(c => `候选源:${c.用}`),
  ];
}

interface LiveRow { baseDate: string; code: string; slotLock: string; status: string | null; netPct: number | null; exitDate: string | null; exitReason: string | null; stage: string | null }

interface LiveSet {
  /** 结清的基准日（当天的预测全部落定）→ 那天的交易 */
  days: Map<string, Trade[]>;
}

function liveSet(db: Db, variantId: string, slots: SlotConfig, lock: Record<string, string>, since: string | null): LiveSet {
  const rows = (db.prepare(
    `SELECT p.base_date, p.code, p.slot_lock, o.status, o.net_pct, o.exit_date, o.exit_reason, p.stage
       FROM shadow_pred p LEFT JOIN shadow_outcome o ON o.pred_id = p.id
      WHERE p.variant_id = ? AND p.source = 'live' ORDER BY p.base_date, p.id`
  ).all(variantId) as any[]).map(r => ({
    baseDate: r.base_date, code: r.code, slotLock: r.slot_lock, status: r.status, netPct: r.net_pct,
    exitDate: r.exit_date, exitReason: r.exit_reason, stage: r.stage,
  }) as LiveRow);
  const keys = slotKeys(slots);
  const okLock = new Map<string, boolean>();
  const lockOk = (s: string): boolean => {
    let v = okLock.get(s);
    if (v === undefined) {
      let parsed: Record<string, string> = {};
      try { parsed = JSON.parse(s); } catch { /* 坏的 lock 当不匹配 */ }
      v = keys.every(k => lock[k] !== undefined && parsed[k] === lock[k]);
      okLock.set(s, v);
    }
    return v;
  };
  const days = new Map<string, Trade[]>();
  const open = new Set<string>();
  for (const r of rows) {
    if (since !== null && r.baseDate <= since) continue;
    if (!lockOk(r.slotLock)) continue;
    if (!days.has(r.baseDate)) days.set(r.baseDate, []);
    if (r.code === "-") continue;                        // 0 候选的哨兵行：只证明那天跑过
    if (r.status === null) { open.add(r.baseDate); continue; }
    days.get(r.baseDate)!.push({
      status: r.status as Trade["status"], netPct: r.netPct, exitDate: r.exitDate,
      exitReason: r.exitReason, stage: r.stage, baseDate: r.baseDate,
    });
  }
  for (const d of open) days.delete(d);                 // 还有没结的，那天整天不算
  return { days };
}

export interface GradCheck {
  variant: string;
  name: string;
  /** 共同结清日 */
  days: number;
  settled: number;
  meanNet: number | null;
  incumbentSettled: number;
  incumbentMean: number | null;
  diff: number | null;
  t: number | null;
  maxDrawdown: number | null;
  incumbentMaxDrawdown: number | null;
  passed: boolean;
  /** 没过的条件，给人看"还差什么" */
  failures: string[];
}

const settledNets = (ts: Trade[]): number[] =>
  ts.filter(t => t.status === "已结算" && t.netPct !== null).map(t => t.netPct as number);
const avg = (xs: number[]): number | null => (xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length);

/** 冷却点：变体最近一次被否决或被回滚的日子。之后攒够 RECONSIDER_AFTER_DAYS 个新交易日才重新参评 */
function cooldownSince(db: Db, variantId: string): string | null {
  const r = db.prepare(
    `SELECT MAX(decided_at) AS t FROM strategy_switch
      WHERE (kind = 'switch' AND status = 'rejected' AND to_variant = ?)
         OR (kind = 'rollback' AND status = 'applied' AND from_variant = ?)`
  ).get(variantId, variantId) as { t: string | null };
  return r.t === null ? null : r.t.slice(0, 10);
}

function variantRow(db: Db, id: string): { id: string; name: string; slots: SlotConfig; status: string } | null {
  const r = db.prepare("SELECT id, name, slot_config, status FROM shadow_variant WHERE id = ?").get(id) as any;
  return r === undefined ? null : { id: r.id, name: r.name, slots: JSON.parse(r.slot_config), status: r.status };
}

export function checkGraduation(db: Db, challengerId: string, incumbentId: string, lock: Record<string, string>): GradCheck {
  const ch = variantRow(db, challengerId), inc = variantRow(db, incumbentId);
  if (ch === null || inc === null) throw new Error(`变体不存在：${ch === null ? challengerId : incumbentId}`);
  const since = cooldownSince(db, challengerId);
  const a = liveSet(db, ch.id, ch.slots, lock, since);
  const b = liveSet(db, inc.id, inc.slots, lock, since);
  const common = [...a.days.keys()].filter(d => b.days.has(d)).sort();
  const ta = common.flatMap(d => a.days.get(d)!), tb = common.flatMap(d => b.days.get(d)!);
  const na = settledNets(ta), nb = settledNets(tb);
  const w = welch(na, nb);
  const ddA = maxDrawdown(ta), ddB = maxDrawdown(tb);
  const ma = avg(na), mb = avg(nb);

  const f: string[] = [];
  if (na.length < GRADUATION.minSettled) f.push(`已结算 ${na.length} 笔，要 ≥ ${GRADUATION.minSettled}`);
  if (common.length < GRADUATION.minDays) f.push(`共同交易日 ${common.length} 天，要 ≥ ${GRADUATION.minDays}`);
  if (ma === null || mb === null || !(ma > mb)) f.push("期望没有高过在任者");
  if (w === null || w.t < GRADUATION.minT) f.push(`t = ${w === null ? "—" : w.t.toFixed(2)}，要 ≥ ${GRADUATION.minT}`);
  if (ddA !== null && ddB !== null && ddA > ddB) f.push(`最大回撤 ${ddA.toFixed(1)} 比在任者 ${ddB.toFixed(1)} 深`);
  if (ch.status !== "active") f.push("变体已退役");
  // 冷却期内的样本已经被 since 滤掉了，这里只把原因说清楚
  if (since !== null && common.length < RECONSIDER_AFTER_DAYS) f.push(`${since} 被否决 / 回滚过，之后只攒了 ${common.length} 天新样本，要 ≥ ${RECONSIDER_AFTER_DAYS}`);

  return {
    variant: ch.id, name: ch.name, days: common.length,
    settled: na.length, meanNet: ma, incumbentSettled: nb.length, incumbentMean: mb,
    diff: w?.diff ?? null, t: w?.t ?? null, maxDrawdown: ddA, incumbentMaxDrawdown: ddB,
    passed: f.length === 0, failures: [...new Set(f)],
  };
}

/** 所有在跑的挑战者对在任者的成绩单，过线的排前面，其余按 t 降序 */
export function graduationBoard(db: Db, incumbentId: string, lock: Record<string, string> = defaultSlotRegistry.lock()): GradCheck[] {
  const ids = (db.prepare("SELECT id FROM shadow_variant WHERE status = 'active' AND id != ? ORDER BY id").all(incumbentId) as Array<{ id: string }>).map(r => r.id);
  return ids.map(id => checkGraduation(db, id, incumbentId, lock))
    .sort((x, y) => Number(y.passed) - Number(x.passed) || (y.t ?? -Infinity) - (x.t ?? -Infinity) || (x.variant < y.variant ? -1 : 1));
}

/* ------------------------------ 切换记录 ------------------------------ */

export interface SwitchRow {
  id: number; kind: "switch" | "rollback"; status: "pending" | "applied" | "rejected" | "stale";
  strategyId: string; fromVariant: string | null; toVariant: string | null;
  fromSlots: string; toSlots: string; fromVersion: string | null; toVersion: string | null;
  evidence: GradCheck | null; decidedBy: "human" | "auto" | null; reverts: number | null;
  note: string | null; proposedAt: string; decidedAt: string | null;
}

function toRow(r: any): SwitchRow {
  return {
    id: r.id, kind: r.kind, status: r.status, strategyId: r.strategy_id,
    fromVariant: r.from_variant, toVariant: r.to_variant, fromSlots: r.from_slots, toSlots: r.to_slots,
    fromVersion: r.from_version, toVersion: r.to_version,
    evidence: r.evidence === null ? null : JSON.parse(r.evidence),
    decidedBy: r.decided_by, reverts: r.reverts, note: r.note, proposedAt: r.proposed_at, decidedAt: r.decided_at,
  };
}

export function switchHistory(db: Db, limit = 50): SwitchRow[] {
  return (db.prepare("SELECT * FROM strategy_switch ORDER BY id DESC LIMIT ?").all(limit) as any[]).map(toRow);
}

function pendingRow(db: Db): SwitchRow | null {
  const r = db.prepare("SELECT * FROM strategy_switch WHERE status = 'pending' ORDER BY id DESC LIMIT 1").get();
  return r === undefined ? null : toRow(r);
}

/** 自上一次回滚以来人批过几次切换。够 MANUAL_APPROVALS_BEFORE_AUTO 次就允许自动 */
export function humanApprovalsSinceRollback(db: Db): number {
  const rows = db.prepare("SELECT kind, decided_by FROM strategy_switch WHERE status = 'applied' ORDER BY id DESC").all() as Array<{ kind: string; decided_by: string }>;
  let n = 0;
  for (const r of rows) {
    if (r.kind === "rollback") break;
    if (r.decided_by === "human") n++;
  }
  return n;
}

export const autoSwitchAllowed = (db: Db): boolean => humanApprovalsSinceRollback(db) >= MANUAL_APPROVALS_BEFORE_AUTO;

function markStale(db: Db, id: number, note: string, now: string): void {
  db.prepare("UPDATE strategy_switch SET status = 'stale', note = ?, decided_at = ? WHERE id = ? AND status = 'pending'").run(note, now, id);
}

/**
 * 改写策略文件：换槽位段 + 升 patch。先整份校验，通过了才写；写临时文件再 rename。
 * 旧版本若从没快照过，先快照 —— 切换之后它的原文就只剩这一份了。
 */
function rewriteStrategy(db: Db, cur: Current, slots: SlotConfig, comment: string): string {
  const ver = bumpPatch(cur.version);
  let next = writeSlotsInText(cur.raw, slots as Record<string, unknown>, comment);
  next = writeParamInText(next, ["version"], ver);
  const v = validateStrategyYaml(next, cur.path);
  if (!v.ok) throw new Error(`改写后的策略文件校验不过：${v.issues.map(i => i.message).join("；")}`);
  if (canonicalJson(v.config.槽位 ?? {}) !== canonicalJson(slots)) throw new Error("改写后读回的槽位与目标不一致，未写入");
  if (!hasSnapshot(db, cur.id, cur.version)) snapshotStrategy(db, { id: cur.id, version: cur.version, yaml: cur.raw });
  const tmp = `${cur.path}.tmp-${process.pid}`;
  try {
    fs.writeFileSync(tmp, next);
    fs.renameSync(tmp, cur.path);
  } finally {
    // rename 成功后 tmp 已不存在；失败时别留半截临时文件
    if (fs.existsSync(tmp)) fs.rmSync(tmp, { force: true });
  }
  return ver;
}

const fmtPct = (x: number | null): string => (x === null ? "—" : `${x >= 0 ? "+" : ""}${x.toFixed(2)}%`);
const evidenceLine = (g: GradCheck): string =>
  `${g.days} 个共同交易日、${g.settled} 笔：期望 ${fmtPct(g.meanNet)}/笔 对在任者 ${fmtPct(g.incumbentMean)}（t = ${g.t?.toFixed(2) ?? "—"}），` +
  `最大回撤 ${g.maxDrawdown?.toFixed(1) ?? "—"} 对 ${g.incumbentMaxDrawdown?.toFixed(1) ?? "—"}`;

/**
 * 批准（或自动执行）一条待批切换。执行前把证据与文件状态都重新核一遍：
 *   - 文件在等批期间被手改过（槽位不再是提案时的在任组合）→ stale，不覆盖人的改动
 *   - 证据不再成立（后来的样本把 t 拉下去了）→ stale
 */
export function approveSwitch(db: Db, id: number, by: "human" | "auto", o: SwitchOpts = {}): SwitchRow {
  const now = o.now ?? shanghaiTs();
  const row = db.prepare("SELECT * FROM strategy_switch WHERE id = ?").get(id);
  if (row === undefined) throw new Error(`切换记录 ${id} 不存在`);
  const sw = toRow(row);
  if (sw.status !== "pending") throw new Error(`切换记录 ${id} 是 ${sw.status}，不是待批`);
  const cur = readCurrent(o);
  if (cur.slotsKey !== sw.fromSlots) {
    markStale(db, id, "等批期间策略文件的槽位被改过，提案作废", now);
    throw new Error(`策略文件的槽位已不是提案时的组合，提案 ${id} 作废（不覆盖手改）`);
  }
  const g = checkGraduation(db, sw.toVariant!, sw.fromVariant!, o.lock ?? defaultSlotRegistry.lock());
  if (!g.passed) {
    markStale(db, id, `证据不再成立：${g.failures.join("；")}`, now);
    throw new Error(`提案 ${id} 的证据不再成立：${g.failures.join("；")}`);
  }
  const to = variantRow(db, sw.toVariant!)!;
  db.transaction(() => {
    const ver = rewriteStrategy(db, cur, JSON.parse(sw.toSlots),
      `影子盘切换 #${id}（${now.slice(0, 10)}，${by === "human" ? "人批" : "自动"}）：${sw.fromVariant} → ${to.id}「${to.name}」。回滚用 pnpm shadow:switch rollback`);
    // 写文件放在事务里、UPDATE 之前：写文件抛错则整个事务回滚，什么都没变。
    // 反过来（文件已写、UPDATE 失败）只剩这一句简单 UPDATE 能出错，概率可以忽略
    db.prepare(
      `UPDATE strategy_switch SET status = 'applied', decided_by = ?, decided_at = ?, from_version = ?, to_version = ?, evidence = ? WHERE id = ?`
    ).run(by, now, cur.version, ver, JSON.stringify(g), id);
  })();
  pushNotification(db, {
    kind: "shadow_switch", severity: "warn",
    title: `策略已切换：${to.name}（${by === "human" ? "人批" : "自动"}）`,
    body: `${sw.fromVariant} → ${to.id}。${evidenceLine(g)}。明天盘前计划起生效；不满意用 pnpm shadow:switch rollback 回滚`,
    dedupeKey: `shadow_switch:applied:${id}`,
  });
  return toRow(db.prepare("SELECT * FROM strategy_switch WHERE id = ?").get(id));
}

export function rejectSwitch(db: Db, id: number, note: string | null = null, now: string = shanghaiTs()): SwitchRow {
  const r = db.prepare("UPDATE strategy_switch SET status = 'rejected', decided_by = 'human', decided_at = ?, note = ? WHERE id = ? AND status = 'pending'").run(now, note, id);
  if (r.changes === 0) throw new Error(`切换记录 ${id} 不是待批状态`);
  return toRow(db.prepare("SELECT * FROM strategy_switch WHERE id = ?").get(id));
}

/**
 * 一键回滚：撤销最近一次生效、且没被撤销过的切换，把槽位段恢复成它之前的样子（版本号照样往前升）。
 * 文件的槽位若已不是那次切换写进去的组合（有人手改过），拒绝 —— 回滚不该覆盖人的改动。
 * 回滚后自动切换暂停：人重新连续批过 2 次才恢复。
 */
export function rollbackSwitch(db: Db, o: SwitchOpts & { note?: string } = {}): SwitchRow {
  const now = o.now ?? shanghaiTs();
  const last = db.prepare(
    `SELECT * FROM strategy_switch s WHERE kind = 'switch' AND status = 'applied'
        AND NOT EXISTS (SELECT 1 FROM strategy_switch r WHERE r.kind = 'rollback' AND r.status = 'applied' AND r.reverts = s.id)
      ORDER BY id DESC LIMIT 1`
  ).get();
  if (last === undefined) throw new Error("没有可回滚的切换");
  const sw = toRow(last);
  const cur = readCurrent(o);
  if (cur.slotsKey !== sw.toSlots) throw new Error(`策略文件的槽位已不是切换 #${sw.id} 写入的组合（被手改过），不回滚`);
  let newId = 0;
  db.transaction(() => {
    const ver = rewriteStrategy(db, cur, JSON.parse(sw.fromSlots),
      `回滚切换 #${sw.id}（${now.slice(0, 10)}）：${sw.toVariant} → ${sw.fromVariant}`);
    newId = Number(db.prepare(
      `INSERT INTO strategy_switch (kind, status, strategy_id, from_variant, to_variant, from_slots, to_slots,
         from_version, to_version, decided_by, reverts, note, proposed_at, decided_at)
       VALUES ('rollback', 'applied', ?, ?, ?, ?, ?, ?, ?, 'human', ?, ?, ?, ?)`
    ).run(cur.id, sw.toVariant, sw.fromVariant, sw.toSlots, sw.fromSlots, cur.version, ver, sw.id, o.note ?? null, now, now).lastInsertRowid);
    db.prepare("UPDATE strategy_switch SET status = 'stale', note = '回滚时作废', decided_at = ? WHERE status = 'pending'").run(now);
  })();
  pushNotification(db, {
    kind: "shadow_switch", severity: "warn",
    title: `策略已回滚：${sw.toVariant} → ${sw.fromVariant}`,
    body: `撤销切换 #${sw.id}。自动切换暂停，之后的切换要人重新批 ${MANUAL_APPROVALS_BEFORE_AUTO} 次`,
    dedupeKey: `shadow_switch:rollback:${newId}`,
  });
  return toRow(db.prepare("SELECT * FROM strategy_switch WHERE id = ?").get(newId));
}

/* ------------------------------ 夜间一轮 ------------------------------ */

export type CycleResult =
  | { action: "none"; reason: string }
  | { action: "pending"; id: number }
  | { action: "stale"; id: number; reason: string }
  | { action: "proposed"; id: number; variant: string }
  | { action: "applied"; id: number; variant: string };

/**
 * 每晚结算之后跑一次：有待批的先复核，没有就找过线的挑战者。
 * 过线的只取一个（t 最高的）：一次只换一套，换了之后下一晚按新的在任者重新比。
 */
export function runSwitchCycle(db: Db, o: SwitchOpts = {}): CycleResult {
  const now = o.now ?? shanghaiTs();
  const lock = o.lock ?? defaultSlotRegistry.lock();
  const cur = readCurrent(o);
  const inc = incumbentOf(db, cur.slotsKey);
  if (inc === null) return { action: "none", reason: "策略文件的槽位组合没有登记为影子盘变体，没有可比的在任者" };

  const p = pendingRow(db);
  if (p !== null) {
    if (p.fromSlots !== cur.slotsKey) {
      markStale(db, p.id, "等批期间策略文件的槽位被改过，提案作废", now);
      return { action: "stale", id: p.id, reason: "策略文件被改过" };
    }
    const g = checkGraduation(db, p.toVariant!, p.fromVariant!, lock);
    if (!g.passed) {
      markStale(db, p.id, `证据不再成立：${g.failures.join("；")}`, now);
      pushNotification(db, {
        kind: "shadow_switch", severity: "info",
        title: `切换提案 #${p.id} 作废`, body: `${p.toVariant} 的证据不再成立：${g.failures.join("；")}`,
        dedupeKey: `shadow_switch:stale:${p.id}`,
      });
      return { action: "stale", id: p.id, reason: g.failures.join("；") };
    }
    return { action: "pending", id: p.id };
  }

  const best = graduationBoard(db, inc, lock).find(g => g.passed);
  if (best === undefined) return { action: "none", reason: "没有挑战者过线" };
  const to = variantRow(db, best.variant)!;
  const id = Number(db.prepare(
    `INSERT INTO strategy_switch (kind, status, strategy_id, from_variant, to_variant, from_slots, to_slots,
       from_version, evidence, proposed_at)
     VALUES ('switch', 'pending', ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(cur.id, inc, to.id, cur.slotsKey, canonicalJson(to.slots), cur.version, JSON.stringify(best), now).lastInsertRowid);

  if (autoSwitchAllowed(db)) {
    try { approveSwitch(db, id, "auto", o); }
    catch (e) {
      // 证据 / 文件核对不过时 approveSwitch 已把它标成 stale；别的错（写文件失败）提案仍是 pending，明晚复核
      const st = (db.prepare("SELECT status FROM strategy_switch WHERE id = ?").get(id) as { status: string }).status;
      console.error(`[影子盘] 自动切换 #${id} 未执行：${(e as Error).message}`);
      return st === "stale" ? { action: "stale", id, reason: (e as Error).message } : { action: "pending", id };
    }
    return { action: "applied", id, variant: to.id };
  }
  const left = MANUAL_APPROVALS_BEFORE_AUTO - humanApprovalsSinceRollback(db);
  pushNotification(db, {
    kind: "shadow_switch", severity: "warn",
    title: `影子盘：「${to.name}」达到毕业线，待你批准`,
    body: `${inc} → ${to.id}。${evidenceLine(best)}。批准：pnpm shadow:switch approve ${id}；否决：pnpm shadow:switch reject ${id}` +
      `（再人批 ${left} 次之后改为自动切换）`,
    dedupeKey: `shadow_switch:proposal:${id}`,
  });
  return { action: "proposed", id, variant: to.id };
}

/* ------------------------------ 看板 ------------------------------ */

export interface SwitchStatus {
  strategyId: string; version: string; slots: SlotConfig;
  incumbent: string | null;
  board: GradCheck[];
  pending: SwitchRow | null;
  history: SwitchRow[];
  autoAllowed: boolean;
  approvalsUntilAuto: number;
}

export function switchStatus(db: Db, o: SwitchOpts = {}): SwitchStatus {
  const cur = readCurrent(o);
  const inc = incumbentOf(db, cur.slotsKey);
  const n = humanApprovalsSinceRollback(db);
  return {
    strategyId: cur.id, version: cur.version, slots: cur.slots, incumbent: inc,
    board: inc === null ? [] : graduationBoard(db, inc, o.lock ?? defaultSlotRegistry.lock()),
    pending: pendingRow(db), history: switchHistory(db, 20),
    autoAllowed: n >= MANUAL_APPROVALS_BEFORE_AUTO,
    approvalsUntilAuto: Math.max(0, MANUAL_APPROVALS_BEFORE_AUTO - n),
  };
}
