/**
 * 情绪截面派生表：建表、增量、口径版本、覆盖不足、以及 PIT 读回的时点。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { buildSentiment } from "@/lib/plan/derived";
import { SENTIMENT_ALGO_VERSION } from "@/lib/factors/sentiment";
import { createSqliteView } from "@/lib/pit/sqlite-view";
import { makeTempDb, insDaily, insSecurity, insCalendar, type TempDb } from "../pit/helpers";

let t: TempDb;
const DAYS = ["2026-09-16", "2026-09-17", "2026-09-18", "2026-09-21", "2026-09-22"];

beforeEach(() => {
  t = makeTempDb();
  insCalendar(t.db, DAYS);
  for (const c of ["600001", "600002", "600003"]) insSecurity(t.db, c);
  // 600001 在 09-21 首板、09-22 二板；其余两只平走
  const px: Record<string, number[]> = {
    "600001": [10, 10, 10, 11, 12.1],
    "600002": [10, 10, 10, 10, 10.1],
    "600003": [10, 10, 10, 10, 9.9],
  };
  for (const [c, ps] of Object.entries(px)) {
    DAYS.forEach((d, i) => insDaily(t.db, c, d, ps[i], { h: ps[i], l: ps[i] }));
  }
});
afterEach(() => { t.close(); });

const row = (d: string) => t.db.prepare("SELECT * FROM sentiment_daily WHERE date = ?").get(d) as any;

describe("buildSentiment", () => {
  it("每个交易日一行，带口径版本", () => {
    const r = buildSentiment(t.db, { from: DAYS[1], to: DAYS[4] });
    expect(r.built).toBe(4);
    expect(row("2026-09-22")).toMatchObject({ zt: 1, max_lbc: 2, first_prev: 1, first_promo: 1, algo_version: SENTIMENT_ALGO_VERSION });
  });

  it("已是当前口径的行不重算，只重算末尾 rebuildRecent 天", () => {
    buildSentiment(t.db, { from: DAYS[1], to: DAYS[4] });
    const r = buildSentiment(t.db, { from: DAYS[1], to: DAYS[4], rebuildRecent: 1 });
    expect(r).toMatchObject({ built: 1, kept: 3 });
  });

  it("口径版本不符的行会被重算 —— 新旧口径不能混在一条分位序列里", () => {
    buildSentiment(t.db, { from: DAYS[1], to: DAYS[4] });
    t.db.prepare("UPDATE sentiment_daily SET algo_version = '0.9.0' WHERE date = ?").run(DAYS[1]);
    const r = buildSentiment(t.db, { from: DAYS[1], to: DAYS[4], rebuildRecent: 0 });
    expect(r).toMatchObject({ built: 1, kept: 3 });
    expect(row(DAYS[1]).algo_version).toBe(SENTIMENT_ALGO_VERSION);
  });

  it("日线覆盖不足一半的日子不建行（因子如实报「未构建」，而不是拿残缺截面污染分位）", () => {
    t.db.prepare("DELETE FROM kline_daily WHERE date = ? AND code != '600001'").run(DAYS[4]);
    const r = buildSentiment(t.db, { from: DAYS[4], to: DAYS[4] });
    expect(r.thin).toBe(1);
    expect(row(DAYS[4])).toBeUndefined();
  });

  it("PIT 读回：只给不晚于评估日的行，升序，字段名与契约一致", () => {
    buildSentiment(t.db, { from: DAYS[1], to: DAYS[4] });
    const h = createSqliteView(t.db, "2026-09-21 15:05:00").sentimentHistory(10);
    expect(h.map(x => x.date)).toEqual(["2026-09-17", "2026-09-18", "2026-09-21"]);
    expect(h[2]).toMatchObject({ zt: 1, firstPrev: 0, firstPromo: null, maxLbc: 1 });
  });
});
