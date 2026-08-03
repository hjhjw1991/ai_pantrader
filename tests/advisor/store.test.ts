import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb, type Db } from "@/lib/db";
import { runMigrations } from "@/lib/db/migrate";
import { DEFAULT_SLOTS, type AdvisorSnapshot } from "@/lib/contracts/advisor";
import { saveSnapshot, loadSnapshots, snapshotInfluenced } from "@/lib/advisor/store";

let dir: string;
let db: Db;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "pt-advisor-"));
  db = openDb(path.join(dir, "t.db"));
  runMigrations(db);
});
afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

function snap(over: Partial<AdvisorSnapshot> = {}): AdvisorSnapshot {
  return {
    ts: "2026-08-03T09:15:00+08:00",
    mode: "claude-cli",
    model: "claude-opus-5",
    promptHash: "p1",
    inputSnapshotHash: "i1",
    slots: {
      gearOverride: "防守",
      scoreAdjust: { "600123": -0.4, "300750": 0.2 },
      extraSectors: ["军工"],
      risks: { "600123": "高位" },
      narrative: "缩量反弹",
    },
    confidence: 0.65,
    degraded: false,
    ...over,
  };
}

describe("advisor store", () => {
  it("快照往返：写进 advisor_output 再读出来完全一致", () => {
    const s = snap();
    saveSnapshot(db, s);
    const got = loadSnapshots(db);
    expect(got).toHaveLength(1);
    expect(got[0]).toEqual(s);
  });

  it("默认/降级快照也留痕 —— 否则无法证明当时 Advisor 跑过", () => {
    const s = snap({ mode: "null", model: null, slots: DEFAULT_SLOTS, confidence: 0, degraded: false });
    saveSnapshot(db, s);
    const got = loadSnapshots(db);
    expect(got).toHaveLength(1);
    expect(got[0].slots).toEqual(DEFAULT_SLOTS);
    expect(got[0].model).toBeNull();
  });

  it("degraded 标记与 confidence 落库并读回", () => {
    saveSnapshot(db, snap({ degraded: true, confidence: 0, slots: DEFAULT_SLOTS }));
    expect(loadSnapshots(db)[0].degraded).toBe(true);
  });

  it("每个槽位一行：个股级建议按 code 展开，环境级 code 留空串", () => {
    saveSnapshot(db, snap());
    const rows = db.prepare("SELECT code, slot FROM advisor_output ORDER BY slot, code").all() as any[];
    expect(rows.some(r => r.slot === "scoreAdjust" && r.code === "600123")).toBe(true);
    expect(rows.some(r => r.slot === "risks" && r.code === "600123")).toBe(true);
    expect(rows.some(r => r.slot === "gearOverride" && r.code === "")).toBe(true);
    expect(rows.some(r => r.slot === "narrative" && r.code === "")).toBe(true);
  });

  it("同 ts 重复写幂等，不撞主键", () => {
    saveSnapshot(db, snap());
    expect(() => saveSnapshot(db, snap())).not.toThrow();
    expect(loadSnapshots(db)).toHaveLength(1);
  });

  it("按时间区间检索（A/B 对比要按 ts 切片）", () => {
    saveSnapshot(db, snap({ ts: "2026-08-01T09:15:00+08:00", inputSnapshotHash: "a" }));
    saveSnapshot(db, snap({ ts: "2026-08-03T09:15:00+08:00", inputSnapshotHash: "b" }));
    saveSnapshot(db, snap({ ts: "2026-08-05T09:15:00+08:00", inputSnapshotHash: "c" }));
    const got = loadSnapshots(db, { from: "2026-08-02", to: "2026-08-04" });
    expect(got.map(s => s.inputSnapshotHash)).toEqual(["b"]);
  });

  it("按是否影响过信号检索：全默认槽位的快照被排除", () => {
    saveSnapshot(db, snap({ ts: "2026-08-01T09:15:00+08:00" }));
    saveSnapshot(db, snap({ ts: "2026-08-02T09:15:00+08:00", slots: DEFAULT_SLOTS }));
    const all = loadSnapshots(db);
    const influenced = loadSnapshots(db, { influencedOnly: true });
    expect(all).toHaveLength(2);
    expect(influenced).toHaveLength(1);
    expect(influenced[0].ts).toBe("2026-08-01T09:15:00+08:00");
  });

  it("不同 promptHash 的运行可区分 —— 换提示词就是换实验条件", () => {
    saveSnapshot(db, snap({ ts: "2026-08-01T09:15:00+08:00", promptHash: "v1" }));
    saveSnapshot(db, snap({ ts: "2026-08-02T09:15:00+08:00", promptHash: "v2" }));
    expect(loadSnapshots(db).map(s => s.promptHash)).toEqual(["v1", "v2"]);
  });

  it("snapshotInfluenced：降级或全默认为 false，有非默认槽为 true", () => {
    expect(snapshotInfluenced(snap({ slots: DEFAULT_SLOTS }))).toBe(false);
    expect(snapshotInfluenced(snap({ degraded: true }))).toBe(false);
    expect(snapshotInfluenced(snap())).toBe(true);
  });

  it("多条快照按 ts 升序返回", () => {
    saveSnapshot(db, snap({ ts: "2026-08-05T09:15:00+08:00" }));
    saveSnapshot(db, snap({ ts: "2026-08-01T09:15:00+08:00" }));
    expect(loadSnapshots(db).map(s => s.ts)).toEqual([
      "2026-08-01T09:15:00+08:00",
      "2026-08-05T09:15:00+08:00",
    ]);
  });
});
