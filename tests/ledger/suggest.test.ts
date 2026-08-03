import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { Db } from "@/lib/db";
import { SUGGEST_MIN_OCCURRENCES, suggestParamChanges } from "@/lib/ledger/suggest";
import { cleanup, seedSettled, tmpDb } from "./helpers";

let db: Db, dir: string;
beforeEach(() => { ({ db, dir } = tmpDb()); });
afterEach(() => cleanup(db, dir));

function cfg() {
  return {
    持仓: { 贼王: { 止损: 0.08 }, 价值: { 止损: 0.15 } },
    选股: {
      过滤器阈值: { 位置涨幅上限: 30 },
      主线识别: { 板块涨幅榜TopN: 10, 必查链: ["半导体设备"] },
    },
  };
}

describe("ledger/suggest", () => {
  it("逆势扛达阈值 → 建议收紧对应账户的止损，路径带账户", () => {
    seedSettled(db, SUGGEST_MIN_OCCURRENCES, {
      idPrefix: "s", hits: 0, advisorInfluenced: false, errorType: "逆势扛", account: "贼王",
    });

    const out = suggestParamChanges(db, { config: cfg(), asOf: "2026-08-04" });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      errorType: "逆势扛",
      occurrences: SUGGEST_MIN_OCCURRENCES,
      paramPath: "持仓.贼王.止损",
      current: 0.08,
      suggested: 0.06,
    });
    expect(out[0].rationale).toContain("止损");
  });

  it("次数没到阈值就不出建议 —— 两三笔就调参等于对噪声过拟合", () => {
    seedSettled(db, SUGGEST_MIN_OCCURRENCES - 1, {
      idPrefix: "t", hits: 0, advisorInfluenced: false, errorType: "逆势扛",
    });
    expect(suggestParamChanges(db, { config: cfg(), asOf: "2026-08-04" })).toEqual([]);
  });

  it("追高 → 位置涨幅上限；板块漏扫 → 板块涨幅榜TopN 放宽", () => {
    seedSettled(db, 3, { idPrefix: "g", hits: 0, advisorInfluenced: false, errorType: "追高" });
    seedSettled(db, 4, { idPrefix: "m", hits: 0, advisorInfluenced: false, errorType: "板块漏扫" });

    const out = suggestParamChanges(db, { config: cfg(), asOf: "2026-08-04" });
    // 按频次降序，方便面板直接展示
    expect(out.map(s => s.errorType)).toEqual(["板块漏扫", "追高"]);
    expect(out.find(s => s.errorType === "追高")).toMatchObject({
      paramPath: "选股.过滤器阈值.位置涨幅上限", current: 30, suggested: 24,
    });
    expect(out.find(s => s.errorType === "板块漏扫")).toMatchObject({
      paramPath: "选股.主线识别.板块涨幅榜TopN", current: 10, suggested: 15,
    });
    // 必查链是写死的，不能被"建议关掉"
    expect(out.every(s => !s.paramPath.includes("必查链"))).toBe(true);
  });

  it("瞬时价误判指向的参数当前不存在 → 照样出建议但标明需新增", () => {
    seedSettled(db, 3, { idPrefix: "p", hits: 0, advisorInfluenced: false, errorType: "瞬时价误判" });
    const out = suggestParamChanges(db, { config: cfg(), asOf: "2026-08-04" });
    expect(out[0].current).toBeNull();
    expect(out[0].suggested).toBe(60);
    expect(out[0].rationale).toContain("新增");
  });

  it("其他 类不出建议 —— 归不到具体规则就没有可调的参数", () => {
    seedSettled(db, 9, { idPrefix: "o", hits: 0, advisorInfluenced: false, errorType: "其他" });
    expect(suggestParamChanges(db, { config: cfg(), asOf: "2026-08-04" })).toEqual([]);
  });

  it("只出建议，绝不动配置对象，也不写库", () => {
    seedSettled(db, 3, { idPrefix: "s", hits: 0, advisorInfluenced: false, errorType: "逆势扛" });
    const c = cfg();
    const before = JSON.stringify(c);
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table'"
    ).all().map((r: any) => r.name);
    const counts = tables.map(t => (db.prepare(`SELECT COUNT(*) n FROM "${t}"`).get() as any).n);

    suggestParamChanges(db, { config: c, asOf: "2026-08-04" });

    expect(JSON.stringify(c)).toBe(before);
    expect(tables.map(t => (db.prepare(`SELECT COUNT(*) n FROM "${t}"`).get() as any).n)).toEqual(counts);
  });

  it("默认只看近 60 天，早已修过的老错误不该反复提", () => {
    seedSettled(db, 3, {
      idPrefix: "old", hits: 0, advisorInfluenced: false, errorType: "逆势扛",
      ts: "2026-01-05T15:30:00+08:00",
    });
    expect(suggestParamChanges(db, { config: cfg(), asOf: "2026-08-04" })).toEqual([]);
  });
});
