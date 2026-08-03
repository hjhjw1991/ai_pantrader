import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { Db } from "@/lib/db";
import {
  LedgerConflictError,
  estimateValidUntil,
  getPrediction,
  listPendingPredictions,
  recordPrediction,
  recordPredictions,
} from "@/lib/ledger/record";
import { cleanup, insertOutcomeRow, mkPred, seedCalendar, tmpDb, weekdays } from "./helpers";

let db: Db, dir: string;
beforeEach(() => { ({ db, dir } = tmpDb()); });
afterEach(() => cleanup(db, dir));

describe("ledger/record", () => {
  it("写入后能原样读回，advisorInfluenced 落库为真值", () => {
    recordPrediction(db, mkPred({ id: "a", advisorInfluenced: true }));
    recordPrediction(db, mkPred({ id: "b", advisorInfluenced: false }));

    const raw = db.prepare("SELECT id, advisor_influenced FROM prediction ORDER BY id")
      .all() as any[];
    expect(raw).toEqual([
      { id: "a", advisor_influenced: 1 },
      { id: "b", advisor_influenced: 0 },
    ]);

    const back = getPrediction(db, "a");
    expect(back).toMatchObject({
      id: "a", code: "300502", action: "买入", account: "贼王",
      evalHorizon: 5, advisorInfluenced: true,
    });
  });

  it("advisorInfluenced 不是布尔值就拒收 —— undefined 静默算成 false 会污染 A/B 的对照组", () => {
    const bad = mkPred();
    delete (bad as any).advisorInfluenced;
    expect(() => recordPrediction(db, bad)).toThrow(/advisorInfluenced/);
    expect(() => recordPrediction(db, mkPred({ advisorInfluenced: 1 as any }))).toThrow(/advisorInfluenced/);
    expect(db.prepare("SELECT COUNT(*) n FROM prediction").get() as any).toEqual({ n: 0 });
  });

  it("非法 evalHorizon 拒收 —— 对账要靠它对齐龙虎榜 D1/D5/D10/D20/D30", () => {
    expect(() => recordPrediction(db, mkPred({ evalHorizon: 3 as any }))).toThrow(/evalHorizon/);
  });

  it("同 id 同内容重复写是幂等的，同 id 改内容直接报错（台账不许被改写）", () => {
    const p = mkPred({ id: "x" });
    recordPrediction(db, p);
    recordPrediction(db, { ...p });
    expect((db.prepare("SELECT COUNT(*) n FROM prediction").get() as any).n).toBe(1);

    expect(() => recordPrediction(db, { ...p, triggerPx: 99 }))
      .toThrow(LedgerConflictError);
    // 冲突后原行必须保持原值
    expect(getPrediction(db, "x")!.triggerPx).toBe(10);
  });

  it("recordPredictions 批量写返回写入条数", () => {
    const n = recordPredictions(db, [mkPred({ id: "m1" }), mkPred({ id: "m2" })]);
    expect(n).toBe(2);
  });

  it("listPendingPredictions 只给到期且未结算的", () => {
    recordPrediction(db, mkPred({ id: "due", validUntil: "2026-08-10" }));
    recordPrediction(db, mkPred({ id: "future", validUntil: "2026-09-01" }));
    recordPrediction(db, mkPred({ id: "settled", validUntil: "2026-08-10" }));
    insertOutcomeRow(db, "settled", "命中", 8);

    expect(listPendingPredictions(db, "2026-08-11").map(p => p.id)).toEqual(["due"]);
  });

  it("estimateValidUntil 日历够长时按交易日算，不够长时明确标成估算", () => {
    const days = weekdays("2026-08-03", 10);
    seedCalendar(db, days);

    // 日历内：2026-08-03 起第 5 个交易日
    expect(estimateValidUntil(db, "2026-08-03", 5)).toEqual({ date: days[5], basis: "交易日" });

    // 日历外：30 个交易日还没生成 —— 只能估，且必须自报是估的
    const far = estimateValidUntil(db, "2026-08-03", 30);
    expect(far.basis).toBe("估算");
    expect(far.date > days[days.length - 1]).toBe(true);
  });
});
