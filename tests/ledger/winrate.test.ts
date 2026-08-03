import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { Db } from "@/lib/db";
import { AB_MIN_SAMPLE_PER_ARM, winRate } from "@/lib/ledger/winrate";
import { cleanup, insertOutcomeRow, insertPredRow, mkPred, seedSettled, tmpDb } from "./helpers";

let db: Db, dir: string;
beforeEach(() => { ({ db, dir } = tmpDb()); });
afterEach(() => cleanup(db, dir));

describe("ledger/winrate", () => {
  it("整体命中率只用有方向的判定做分母，中性单独计数", () => {
    seedSettled(db, 10, { idPrefix: "a", hits: 6, advisorInfluenced: false });
    insertPredRow(db, mkPred({ id: "neutral1" }));
    insertOutcomeRow(db, "neutral1", "中性", 0.5);

    const s = winRate(db);
    expect(s.settled).toBe(11);
    expect(s.neutral).toBe(1);
    expect(s.total).toBe(10);
    expect(s.hit).toBe(6);
    expect(s.rate).toBeCloseTo(0.6, 6);
  });

  it("按 phase 分组，三个时段的键永远都在（前端不用判空）", () => {
    seedSettled(db, 4, { idPrefix: "pre", hits: 3, advisorInfluenced: false, phase: "盘前" });
    seedSettled(db, 2, { idPrefix: "mid", hits: 0, advisorInfluenced: false, phase: "盘中" });

    const s = winRate(db);
    expect(Object.keys(s.byPhase).sort()).toEqual(["盘中", "盘后", "盘前"].sort());
    expect(s.byPhase["盘前"]).toEqual({ total: 4, hit: 3 });
    expect(s.byPhase["盘中"]).toEqual({ total: 2, hit: 0 });
    expect(s.byPhase["盘后"]).toEqual({ total: 0, hit: 0 });
  });

  it("按错误类型计数，五类键齐全（闭枚举才数得清）", () => {
    seedSettled(db, 3, { idPrefix: "e", hits: 0, advisorInfluenced: false, errorType: "追高" });
    const s = winRate(db);
    expect(s.byErrorType["追高"]).toBe(3);
    expect(s.byErrorType["逆势扛"]).toBe(0);
    expect(Object.keys(s.byErrorType)).toHaveLength(5);
  });

  it("A/B 小样本时拒绝把差值当结论，但样本量必须一起报出来", () => {
    seedSettled(db, 4, { idPrefix: "w", hits: 4, advisorInfluenced: true });
    seedSettled(db, 4, { idPrefix: "o", hits: 1, advisorInfluenced: false });

    const s = winRate(db);
    expect(s.advisorAB).toEqual({ with: { total: 4, hit: 4 }, without: { total: 4, hit: 1 } });
    expect(s.ab.comparable).toBe(false);
    expect(s.ab.deltaPct).toBeNull();          // 不给差值，避免被当成"Claude 提升 75pp"
    expect(s.ab.minSamplePerArm).toBe(AB_MIN_SAMPLE_PER_ARM);
    expect(s.ab.note).toContain("4");
    expect(s.ab.note).toContain("样本不足");
  });

  it("两臂都到阈值才给差值，且措辞不许说因果", () => {
    const n = AB_MIN_SAMPLE_PER_ARM;
    seedSettled(db, n, { idPrefix: "W", hits: Math.round(n * 0.6), advisorInfluenced: true });
    seedSettled(db, n, { idPrefix: "O", hits: Math.round(n * 0.5), advisorInfluenced: false });

    const s = winRate(db);
    expect(s.ab.comparable).toBe(true);
    expect(s.ab.withRate).toBeCloseTo(0.6, 2);
    expect(s.ab.withoutRate).toBeCloseTo(0.5, 2);
    expect(s.ab.deltaPct).toBeCloseTo(10, 1);
    expect(s.ab.note).not.toContain("因为");
  });

  it("支持按时间/标的过滤", () => {
    seedSettled(db, 2, { idPrefix: "old", hits: 2, advisorInfluenced: false, ts: "2026-06-01T15:30:00+08:00" });
    seedSettled(db, 2, { idPrefix: "new", hits: 0, advisorInfluenced: false, ts: "2026-08-03T15:30:00+08:00", code: "002131" });

    expect(winRate(db, { from: "2026-07-01" }).total).toBe(2);
    expect(winRate(db, { from: "2026-07-01" }).hit).toBe(0);
    expect(winRate(db, { code: "002131" }).total).toBe(2);
  });

  it("没有样本时 rate 给 0 且 total 为 0 —— 调用方必须看 total 再展示", () => {
    const s = winRate(db);
    expect(s).toMatchObject({ total: 0, hit: 0, rate: 0 });
    expect(s.ab.comparable).toBe(false);
  });
});
