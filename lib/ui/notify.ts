import type { Db } from "@/lib/db";
import { shanghaiTs } from "@/lib/data/clock";
import type { SignalCard } from "@/lib/contracts";

/**
 * 通知的产生与读取。spec §13：只有关键信号才响。
 *
 * 判定"关键"的原则：**要求人做动作的才响**。
 * 数据刷新了、某轮采集完成了 —— 界面更新即可，弹通知只会训练用户忽略通知，
 * 最后连硬线告警一起被无视。
 */

export type Severity = "critical" | "warn" | "info";

export interface Notification {
  id: number;
  ts: string;
  kind: string;
  severity: Severity;
  title: string;
  body: string | null;
  readAt: string | null;
}

/** 写入一条通知。带 dedupeKey 时同一件事只留一条。 */
export function pushNotification(
  db: Db,
  n: { kind: string; severity: Severity; title: string; body?: string; dedupeKey?: string }
): boolean {
  try {
    db.prepare(
      `INSERT INTO notification (ts, kind, severity, title, body, dedupe_key)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(shanghaiTs(), n.kind, n.severity, n.title, n.body ?? null, n.dedupeKey ?? null);
    return true;
  } catch {
    return false;    // dedupe_key 冲突 = 这件事已经通知过
  }
}

export function recentNotifications(db: Db, sinceId = 0, limit = 50): Notification[] {
  return (db.prepare(
    `SELECT id, ts, kind, severity, title, body, read_at FROM notification
     WHERE id > ? ORDER BY id DESC LIMIT ?`
  ).all(sinceId, limit) as any[]).map(r => ({
    id: r.id, ts: r.ts, kind: r.kind, severity: r.severity,
    title: r.title, body: r.body, readAt: r.read_at,
  }));
}

export function markRead(db: Db, upToId: number): number {
  const r = db.prepare(
    `UPDATE notification SET read_at = ? WHERE id <= ? AND read_at IS NULL`
  ).run(shanghaiTs(), upToId);
  return r.changes;
}

export interface SignalState {
  gear: string | null;
  candidates: string;
  alertCount: number;
}

export function readSignalState(db: Db): SignalState | null {
  const r = db.prepare(`SELECT gear, candidates, alert_count FROM signal_state WHERE id = 1`)
    .get() as any;
  return r === undefined
    ? null
    : { gear: r.gear, candidates: r.candidates, alertCount: r.alert_count };
}

function writeSignalState(db: Db, s: SignalState): void {
  db.prepare(
    `INSERT INTO signal_state (id, ts, gear, candidates, alert_count) VALUES (1, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET ts = excluded.ts, gear = excluded.gear,
       candidates = excluded.candidates, alert_count = excluded.alert_count`
  ).run(shanghaiTs(), s.gear, s.candidates, s.alertCount);
}

/**
 * 比对信号卡与上次状态，把**需要人做动作**的变化写成通知。
 *
 * 三类会响：
 *   档位切换   —— 直接改变目标仓位，尤其切到防守（= 空仓）
 *   新增候选   —— 有票到了可买条件
 *   硬线告警   —— 破止损/破灾难位，critical
 * 首次运行（没有上次状态）不通知：那不是"变化"，只是第一次看到。
 */
export function diffAndNotify(db: Db, card: SignalCard, alertCount = 0): Notification[] {
  const codes = [...new Set(card.candidates.map(c => c.code))].sort().join(",");
  const next: SignalState = { gear: card.env.gear, candidates: codes, alertCount };
  const prev = readSignalState(db);
  writeSignalState(db, next);

  if (prev === null) return [];    // 首次，无从比较

  const day = shanghaiTs().slice(0, 10);
  const fired: string[] = [];

  if (prev.gear !== next.gear) {
    const toDefense = next.gear === "防守";
    if (pushNotification(db, {
      kind: "gear_change",
      // 切防守要求立刻降到空仓，不是"留意一下"
      severity: toDefense ? "critical" : "warn",
      title: `环境档位 ${prev.gear} → ${next.gear}`,
      body: toDefense
        ? "防守档 = 空仓，不是轻仓。按纪律清掉波动仓。"
        : `目标仓位 ${card.env.targetPosition}`,
      dedupeKey: `gear:${day}:${prev.gear}->${next.gear}`,
    })) fired.push("gear_change");
  }

  const prevSet = new Set(prev.candidates.split(",").filter(Boolean));
  const added = card.candidates.filter(c => !prevSet.has(c.code));
  for (const c of added) {
    if (c.action !== "买入" && c.action !== "加仓") continue;   // 观察类不响
    if (pushNotification(db, {
      kind: "new_candidate", severity: "warn",
      title: `${c.action} ${c.code} ${c.name}`,
      body: `触发 ${c.triggerPx ?? "—"} / 止损 ${c.stopPx ?? "—"}｜${c.thesis}`,
      dedupeKey: `cand:${day}:${c.code}:${c.action}`,
    })) fired.push("new_candidate");
  }

  if (next.alertCount > prev.alertCount) {
    if (pushNotification(db, {
      kind: "hard_line", severity: "critical",
      title: `硬线告警 ${next.alertCount} 条`,
      body: "持仓触及止损或灾难位，纪律优先于当下的盘面感觉。",
      dedupeKey: `hardline:${day}:${next.alertCount}`,
    })) fired.push("hard_line");
  }

  return fired.length === 0 ? [] : recentNotifications(db, 0, fired.length);
}
