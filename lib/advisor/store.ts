import type { Db } from "@/lib/db";
import type { AdvisorMode, AdvisorSnapshot, AdvisorSlots } from "@/lib/contracts/advisor";
import { cloneDefaultSlots, isDefaultSlots, GEARS } from "@/lib/advisor/slots";

/**
 * 快照落库 / 读回（spec §5.2 留痕，§5.3 A/B）。
 *
 * 表结构是 advisor_output(ts, code, slot, value, ...)，主键 (ts, code, slot)：
 *   - 环境级槽位（gearOverride/extraSectors/narrative）code 留空串
 *   - 个股级槽位（scoreAdjust/risks）按 code 展开成多行，方便按票查"当时模型怎么说的"
 *
 * 三个刻意的决定：
 *   1. 即使槽位全默认也要写那 3 行环境级记录。否则事后无法区分
 *      "当天 Advisor 跑了但没建议"和"当天压根没跑" —— A/B 的对照组会凭空少样本。
 *   2. prompt_hash / input_snapshot_hash 每行都带。换提示词就是换实验条件，
 *      不同 prompt 的运行必须能分开统计，不能混进同一组均值。
 *   3. INSERT OR REPLACE：同一时点重跑（比如手工重扫盘）覆盖旧值，不撞主键。
 */

export const ENV_LEVEL_CODE = "";
export const ENV_LEVEL_SLOTS = ["gearOverride", "extraSectors", "narrative"] as const;
export const PER_CODE_SLOTS = ["scoreAdjust", "risks"] as const;

interface Row {
  ts: string;
  code: string;
  slot: string;
  value: string | null;
  mode: string;
  model: string | null;
  prompt_hash: string;
  input_snapshot_hash: string;
  confidence: number | null;
  degraded: number;
}

function rowsOf(snap: AdvisorSnapshot): Row[] {
  const base = {
    ts: snap.ts,
    mode: snap.mode,
    model: snap.model,
    prompt_hash: snap.promptHash,
    input_snapshot_hash: snap.inputSnapshotHash,
    confidence: snap.confidence,
    degraded: snap.degraded ? 1 : 0,
  };
  const rows: Row[] = [
    { ...base, code: ENV_LEVEL_CODE, slot: "gearOverride", value: JSON.stringify(snap.slots.gearOverride ?? null) },
    { ...base, code: ENV_LEVEL_CODE, slot: "extraSectors", value: JSON.stringify(snap.slots.extraSectors ?? []) },
    { ...base, code: ENV_LEVEL_CODE, slot: "narrative", value: JSON.stringify(snap.slots.narrative ?? null) },
  ];
  for (const [code, delta] of Object.entries(snap.slots.scoreAdjust ?? {})) {
    rows.push({ ...base, code, slot: "scoreAdjust", value: JSON.stringify(delta) });
  }
  for (const [code, risk] of Object.entries(snap.slots.risks ?? {})) {
    rows.push({ ...base, code, slot: "risks", value: JSON.stringify(risk) });
  }
  return rows;
}

const INSERT = `INSERT OR REPLACE INTO advisor_output
  (ts, code, slot, value, mode, model, prompt_hash, input_snapshot_hash, confidence, degraded)
  VALUES (@ts, @code, @slot, @value, @mode, @model, @prompt_hash, @input_snapshot_hash, @confidence, @degraded)`;

/** 返回写入行数。整体一个事务：半截留痕比没留痕更难查 */
export function saveSnapshot(db: Db, snap: AdvisorSnapshot): number {
  const rows = rowsOf(snap);
  const stmt = db.prepare(INSERT);
  db.transaction(() => {
    for (const r of rows) stmt.run(r);
  })();
  return rows.length;
}

export function saveSnapshots(db: Db, snaps: AdvisorSnapshot[]): number {
  let n = 0;
  for (const s of snaps) n += saveSnapshot(db, s);
  return n;
}

/**
 * 这份快照是否真的影响过信号。
 * 降级快照按定义没影响（槽位全默认），全默认槽位也没影响。
 * 下游 prediction.advisor_influenced 的 A/B 分组就靠这个判断，所以宁可保守。
 */
export function snapshotInfluenced(snap: AdvisorSnapshot): boolean {
  if (snap.degraded) return false;
  return !isDefaultSlots(snap.slots);
}

export interface SnapshotQuery {
  /** 含端点，按 ts 字符串比较（ISO 前缀比较即可，如 "2026-08-02"） */
  from?: string;
  to?: string;
  /** 只要真的影响过信号的快照 —— spec §5.3 的 with_advisor 组 */
  influencedOnly?: boolean;
  mode?: AdvisorMode;
  promptHash?: string;
}

function parseJson(v: string | null): unknown {
  if (v === null) return null;
  try {
    return JSON.parse(v);
  } catch {
    return null; // 库里的脏值不该让读取整体失败
  }
}

export function loadSnapshots(db: Db, q: SnapshotQuery = {}): AdvisorSnapshot[] {
  const where: string[] = [];
  const args: unknown[] = [];
  if (q.from) {
    where.push("ts >= ?");
    args.push(q.from);
  }
  if (q.to) {
    // to 用 "<= to + ￿" 让 "2026-08-04" 能覆盖当天带时间的行
    where.push("ts <= ?");
    args.push(`${q.to}￿`);
  }
  if (q.mode) {
    where.push("mode = ?");
    args.push(q.mode);
  }
  if (q.promptHash) {
    where.push("prompt_hash = ?");
    args.push(q.promptHash);
  }
  const sql = `SELECT * FROM advisor_output${where.length ? ` WHERE ${where.join(" AND ")}` : ""}
    ORDER BY ts ASC, slot ASC, code ASC`;
  const rows = db.prepare(sql).all(...(args as any[])) as Row[];

  // 同一次调用的行靠 (ts, mode, prompt_hash, input_snapshot_hash) 归组。
  // 只按 ts 归组是不够的：同一时点可能跑过两种模式/两版提示词做对比。
  const groups = new Map<string, { snap: AdvisorSnapshot }>();
  for (const r of rows) {
    const key = `${r.ts}|${r.mode}|${r.prompt_hash}|${r.input_snapshot_hash}`;
    let g = groups.get(key);
    if (!g) {
      g = {
        snap: {
          ts: r.ts,
          mode: r.mode as AdvisorMode,
          model: r.model,
          promptHash: r.prompt_hash,
          inputSnapshotHash: r.input_snapshot_hash,
          slots: cloneDefaultSlots(),
          confidence: r.confidence ?? 0,
          degraded: r.degraded === 1,
        },
      };
      groups.set(key, g);
    }
    applyRow(g.snap.slots, r);
  }

  const out = [...groups.values()].map(g => g.snap);
  return q.influencedOnly ? out.filter(snapshotInfluenced) : out;
}

function applyRow(slots: AdvisorSlots, r: Row): void {
  const value = parseJson(r.value);
  switch (r.slot) {
    case "gearOverride":
      slots.gearOverride =
        typeof value === "string" && (GEARS as string[]).includes(value) ? (value as AdvisorSlots["gearOverride"]) : null;
      break;
    case "extraSectors":
      slots.extraSectors = Array.isArray(value) ? value.filter((x): x is string => typeof x === "string") : [];
      break;
    case "narrative":
      slots.narrative = typeof value === "string" ? value : null;
      break;
    case "scoreAdjust":
      if (typeof value === "number" && Number.isFinite(value)) slots.scoreAdjust[r.code] = value;
      break;
    case "risks":
      if (typeof value === "string") slots.risks[r.code] = value;
      break;
    default:
      // 库里出现未知槽位（未来版本写的）：忽略，不让旧代码读崩
      break;
  }
}
