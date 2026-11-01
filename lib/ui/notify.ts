import type { Db } from "@/lib/db";
import { shanghaiTs } from "@/lib/data/clock";
import type { SignalCard } from "@/lib/contracts";
import { pushOutbound } from "@/lib/ui/push";

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
    const ts = shanghaiTs();
    db.prepare(
      `INSERT INTO notification (ts, kind, severity, title, body, dedupe_key)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(ts, n.kind, n.severity, n.title, n.body ?? null, n.dedupeKey ?? null);
    // 外发到手机。写库成功才推，避免 dedupe 冲突时把同一件事重复炸到手机上。
    // pushOutbound 内部：没配就零开销返回，失败静默，不等网络。
    pushOutbound({ kind: n.kind, severity: n.severity, title: n.title, body: n.body ?? null, ts });
    return true;
  } catch {
    return false;    // dedupe_key 冲突 = 这件事已经通知过
  }
}

function rowToNotification(r: any): Notification {
  return {
    id: r.id, ts: r.ts, kind: r.kind, severity: r.severity,
    title: r.title, body: r.body, readAt: r.read_at,
  };
}

export function recentNotifications(db: Db, sinceId = 0, limit = 50): Notification[] {
  return (db.prepare(
    `SELECT id, ts, kind, severity, title, body, read_at FROM notification
     WHERE id > ? ORDER BY id DESC LIMIT ?`
  ).all(sinceId, limit) as any[]).map(rowToNotification);
}

/**
 * 倒序翻页（铃铛里的"加载更多"）。
 *
 * beforeId = 0 是第一页（最新的 limit 条），之后每页传当前已加载的最小 id。
 * 用 id 游标而不是 OFFSET：通知在盘中不断写入，OFFSET 会因为新插入的行
 * 把已经在展示的那几条又推回来一次（重复项），而 id 游标不受插入影响。
 */
export function notificationsPage(db: Db, beforeId: number, limit: number): Notification[] {
  const rows = (beforeId > 0
    ? db.prepare(
        `SELECT id, ts, kind, severity, title, body, read_at FROM notification
         WHERE id < ? ORDER BY id DESC LIMIT ?`
      ).all(beforeId, limit)
    : db.prepare(
        `SELECT id, ts, kind, severity, title, body, read_at FROM notification
         ORDER BY id DESC LIMIT ?`
      ).all(limit)) as any[];
  return rows.map(rowToNotification);
}

/** 通知总条数。铃铛拿它算"还有 N 条没显示" */
export function countNotifications(db: Db): number {
  const r = db.prepare(`SELECT COUNT(*) n FROM notification`).get() as any;
  return Number(r?.n ?? 0);
}

/**
 * 当前最大通知 id。
 *
 * 给 SSE 用的"连接时刻水位"：一个通知连接建立时记下这个值，之后只推送 id 比它大的
 * （即连接之后才产生的）通知，连接之前的历史走单独的 history 事件回填，避免每次刷新
 * 把全部历史当新消息弹一遍桌面通知。
 */
export function maxNotificationId(db: Db): number {
  const r = db.prepare(`SELECT MAX(id) m FROM notification`).get() as any;
  return Number(r?.m ?? 0);
}

/**
 * SSE 连接建立时该回填的「历史」与「水位」。
 *
 * 历史（最新的 limit 条）走 `history` 事件一次性推给铃铛与顶栏硬线展示；
 * 水位 = max(sinceId, 当前最大 id) 之后的通知，才在后续轮询里作为 `notify` 事件推送 ——
 * 客户端只对 `notify` 弹桌面通知，于是历史不会在每次刷新时被重弹一遍。
 *
 * 把这段逻辑从 SSE 路由里抽出来，是因为它既是这次 bug 修复的核心（历史/实时的分界），
 * 又必须能被纯函数测试覆盖而不用把整个 next 路由拉进测试（后者会触发 SSR 转译缓存写入，
 * 在受限环境里偶发 EPERM，把整文件测试拖垮）。
 */
export interface ConnectionFeed {
  history: Notification[];
  waterMark: number;
}

export function connectionBackfill(db: Db, sinceId: number, limit = 50): ConnectionFeed {
  const history = recentNotifications(db, 0, limit);
  const waterMark = Math.max(sinceId, maxNotificationId(db));
  return { history, waterMark };
}

/**
 * 校验「标记已读」的 upToId。非法（非 number / 非整数 / 负数 / null / undefined / 字符串）返回 null。
 *
 * 用 typeof 先拦：Number(null) === 0、Number(undefined) === NaN，单独用 Number() 会把
 * null 误判进非负整数分支（当成"标 0 条"），必须显式拒绝非 number。
 */
export function parseReadUpToId(raw: unknown): number | null {
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 0) return null;
  return raw;
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
