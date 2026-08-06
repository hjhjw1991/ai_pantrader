import type { Db } from "@/lib/db";
import {
  activeStrategyPath, readStrategyRaw, removeStrategyFile,
} from "@/lib/strategy/registry";
import { validateStrategyYaml } from "@/lib/strategy/schema";
import { readFileSync } from "node:fs";

/**
 * 策略版本快照 —— **删除策略这件事能安全存在的唯一前提。**
 *
 * prediction.strategy_id 是台账的归因键。直接删掉策略文件，历史预测就指向一个
 * 不存在的策略：按策略分组的胜率凭空少一组、回测结论再也归不了因，而且没有任何提示
 * （lib/backup/export.ts 里已经为这个风险把 strategy 表放进了 .ptbak）。
 *
 * 所以：一旦某个版本产生过预测，它的**原文**就被快照进 strategy 表。
 * 之后文件随便删，台账仍然解释得清「这条预测当时依据的是哪一套参数」。
 *
 * 为什么这一层在 ledger 而不是 lib/strategy：那边有纯度断言（spec §17 断言 3），
 * 决策层碰存储会让回测不可复现。查引用、写快照都是台账的活。
 */

/**
 * 写入一份版本快照。
 *
 * 幂等且**只留第一份**：同 (id, version) 第二次调用不覆盖。
 * 允许覆盖就不是快照了 —— 改一个阈值再覆盖，历史预测的归因会跟着悄悄变，
 * 而"回测结论可复现"正是靠这份不可变副本兜住的。
 */
export function snapshotStrategy(
  db: Db,
  s: { id: string; version: string; yaml: string; factorsLock?: Record<string, string> | null }
): boolean {
  const r = db.prepare(
    `INSERT OR IGNORE INTO strategy (id, version, yaml, factors_lock, created_at, active)
     VALUES (?, ?, ?, ?, ?, 0)`
  ).run(
    s.id, s.version, s.yaml,
    s.factorsLock ? JSON.stringify(s.factorsLock) : null,
    new Date().toISOString()
  );
  return r.changes > 0;
}

export function hasSnapshot(db: Db, id: string, version?: string): boolean {
  const sql = version === undefined
    ? `SELECT 1 FROM strategy WHERE id = ? LIMIT 1`
    : `SELECT 1 FROM strategy WHERE id = ? AND version = ? LIMIT 1`;
  return db.prepare(sql).get(...(version === undefined ? [id] : [id, version])) !== undefined;
}

/** 台账里有多少条预测挂在这个策略上 */
export function predictionCount(db: Db, id: string): number {
  return (db.prepare(
    `SELECT COUNT(*) c FROM prediction WHERE strategy_id = ?`
  ).get(id) as { c: number }).c;
}

/**
 * 台账开始依赖某个策略的那一刻，把它的原文快照下来。
 *
 * 时机是**第一条预测落库**，不是"策略新建时"：新建的策略可能永远没跑过，
 * 快照它只是噪音。而从第一条预测起，那套参数就必须永远解释得清。
 *
 * 只快照 id 对得上的那份：引擎用的策略与当前 active 不一致时宁可不快照 ——
 * 快照错了比没有更糟，它会把另一套参数说成是这条预测的依据。
 */
export function snapshotForPrediction(db: Db, strategyId: string): boolean {
  if (hasSnapshot(db, strategyId)) return false;
  const p = activeStrategyPath();
  if (p === null) return false;
  const raw = readFileSync(p, "utf8");
  const r = validateStrategyYaml(raw, p);
  if (!r.ok || r.config.id !== strategyId) return false;
  return snapshotStrategy(db, { id: strategyId, version: r.config.version, yaml: raw });
}

export interface DeleteStrategyResult {
  id: string;
  fileRemoved: boolean;
  /** 为了保住台账归因而现场补的快照数（0 或 1） */
  snapshotted: number;
  predictions: number;
  note: string;
}

/**
 * 删除策略：有预测挂着就**先快照再删文件**。
 *
 * 顺序不能反。先删文件的话原文就没了，再想快照只能拿别的版本凑，
 * 那等于把错的参数集写成这些预测的依据。
 *
 * 拒绝规则（在跑的 / 最后一个）在 registry.removeStrategyFile 里，
 * 因为它们只和文件状态有关。这里只加"引用"这一维。
 */
export function deleteStrategy(db: Db, id: string): DeleteStrategyResult {
  const preds = predictionCount(db, id);
  let snapshotted = 0;
  if (preds > 0 && !hasSnapshot(db, id)) {
    const cur = readStrategyRaw(id);
    if (cur !== null && snapshotStrategy(db, { id, version: cur.version, yaml: cur.raw })) {
      snapshotted = 1;
    }
  }
  // removeStrategyFile 会把两条拒绝抛出来；抛了就什么都没删，快照多写一份无害
  removeStrategyFile(id);
  return {
    id, fileRemoved: true, snapshotted, predictions: preds,
    note: preds > 0
      ? `台账里有 ${preds} 条预测挂在 ${id} 上，原文已在 strategy 表留有快照，归因不丢`
      : `没有预测引用 ${id}，直接删除`,
  };
}
