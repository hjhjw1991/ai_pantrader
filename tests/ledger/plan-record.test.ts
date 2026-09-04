import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { Db } from "@/lib/db";
import type { SignalCard } from "@/lib/contracts";
import { recordPlan, planPredictions, planPredictionId, planValidUntil, PLAN_EVAL_HORIZON } from "@/lib/plan/record";
import { LedgerConflictError, recordPredictions } from "@/lib/ledger/record";
import { cleanup, seedCalendar, tmpDb, weekdays } from "./helpers";

let db: Db, dir: string;
beforeEach(() => {
  ({ db, dir } = tmpDb());
  seedCalendar(db, weekdays("2026-08-03", 40));
});
afterEach(() => cleanup(db, dir));

function card(over: Partial<SignalCard> = {}): SignalCard {
  const c = (code: string, action: SignalCard["candidates"][number]["action"]) => ({
    code, name: code, action, account: "卫星" as const,
    triggerPx: 10, stopPx: 9, size: 0.1, thesis: "测试",
    passedFilters: [], factors: [], score: 1,
  });
  return {
    ts: "2026-08-04T09:15:00+08:00",
    phase: "盘前",
    strategyId: "s1",
    env: { gear: "中性", targetPosition: 0.4, reasons: [], factors: [], lowConfidenceFactors: [] },
    candidates: [c("300502", "买入")],
    holdings: [c("600519", "持有")],
    warnings: [],
    advisorInfluenced: false,
    ...over,
  };
}

/**
 * 台账是这套复盘的唯一输入。它必须满足两条：事前记（事后补记等于事后选样本），
 * 允许重投但不允许改写（能被改写的台账不再是台账）。
 */
describe("plan/record 落台账", () => {
  it("整卡都记：candidates + holdings —— 只记买入会让防守做得对不对永远看不出来", () => {
    const r = recordPlan(db, card(), "2026-08-04", "2026-08-04T09:15:00+08:00");
    expect(r.recorded).toBe(2);
    const rows = db.prepare("SELECT code, action, eval_horizon FROM prediction ORDER BY code").all() as any[];
    expect(rows.map(x => x.code)).toEqual(["300502", "600519"]);
    expect(rows.every(x => x.eval_horizon === PLAN_EVAL_HORIZON)).toBe(true);
  });

  it("id 由内容推导，一天一批", () => {
    recordPlan(db, card(), "2026-08-04", "2026-08-04T09:15:00+08:00");
    recordPlan(db, card(), "2026-08-04", "2026-08-04T09:15:00+08:00");
    expect((db.prepare("SELECT COUNT(*) n FROM prediction").get() as any).n).toBe(2);
    expect(planPredictionId("2026-08-04", "s1", "300502", "买入"))
      .toBe("2026-08-04:s1:300502:买入");
  });

  /**
   * 幂等的判据是内容指纹，而指纹含 ts —— job 重跑时挂钟时间必然不同，
   * 靠 recordPrediction 的幂等去兜会变成"重跑必炸"。所以在批次这一层去重。
   */
  it("job 重跑（时间不同）整批跳过，不抛错也不写第二份", () => {
    recordPlan(db, card(), "2026-08-04", "2026-08-04T09:15:00+08:00");
    const again = recordPlan(db, card(), "2026-08-04", "2026-08-04T10:31:00+08:00");
    expect(again).toMatchObject({ recorded: 0, skipped: true, alreadyRecorded: true });
    expect((db.prepare("SELECT COUNT(*) n FROM prediction").get() as any).n).toBe(2);
  });

  it("候选变了也不改写当天已记的那批 —— 能被改写的台账不再是台账", () => {
    recordPlan(db, card(), "2026-08-04", "2026-08-04T09:15:00+08:00");
    const changed = card();
    changed.candidates[0].triggerPx = 11;
    const r = recordPlan(db, changed, "2026-08-04", "2026-08-04T09:15:00+08:00");
    expect(r.alreadyRecorded).toBe(true);
    expect((db.prepare("SELECT trigger_px FROM prediction WHERE code='300502'").get() as any).trigger_px)
      .toBe(10);
  });

  it("直接走 recordPredictions 时，同 id 不同内容仍然报错", () => {
    const preds = planPredictions(card(), "2026-08-04", "2026-08-04T09:15:00+08:00", 5, "2026-08-11");
    recordPredictions(db, preds);
    expect(() => recordPredictions(db, preds.map(p => ({ ...p, triggerPx: 11 }))))
      .toThrow(LedgerConflictError);
  });

  it("valid_until 按交易日推，不按自然日 —— 跨长假的 +5 天可能一个交易日都没走完", () => {
    const preds = planPredictions(card(), "2026-08-04", "2026-08-04T09:15:00+08:00", 5, "2026-08-11");
    expect(preds[0].validUntil).toBe("2026-08-11");
    const r = recordPlan(db, card(), "2026-08-04", "2026-08-04T09:15:00+08:00");
    const row = db.prepare("SELECT valid_until FROM prediction LIMIT 1").get() as any;
    // 08-04 之后第 5 个交易日是 08-11（跨一个周末）
    expect(row.valid_until).toBe("2026-08-11");
    expect(r.skipped).toBe(false);
  });

  /**
   * 生产库的交易日历是从已落库行情反推的，最远只到今天 ——
   * 盘前 09:15 记的这批预测，它们的到期日在日历上根本还不存在。
   * 早先这里拒绝写入，结果是盘前计划永远落不了台账（静默失效）。
   */
  it("日历排不到到期日时退回自然日估算，照样写 —— 拒绝写入会让台账永远是空的", () => {
    const beyond = "2026-09-24";   // 日历只到 2026-08-03 起 40 个工作日
    expect(planValidUntil(db, beyond, 5)).toBe("2026-10-04");   // 5 个交易日≈7 天，再加 3 天余量
    const r = recordPlan(db, card(), beyond, `${beyond}T09:15:00+08:00`);
    expect(r.recorded).toBe(2);
    expect(r.skipped).toBe(false);
    expect((db.prepare("SELECT COUNT(*) n FROM prediction").get() as any).n).toBe(2);
  });

  it("日历够长时仍用交易日 —— 精确，且横跨长假不会算早", () => {
    expect(planValidUntil(db, "2026-08-04", 5)).toBe("2026-08-11");
  });

  it("advisorInfluenced 原样透传，绝不默认 false —— 默认值会把 A/B 差值弄成假的", () => {
    recordPlan(db, card({ advisorInfluenced: true }), "2026-08-04", "2026-08-04T09:15:00+08:00");
    const rows = db.prepare("SELECT advisor_influenced FROM prediction").all() as any[];
    expect(rows.every(r => r.advisor_influenced === 1)).toBe(true);
  });

  it("空卡不写也不报错：防守档 0 仓、或全被过滤器否决，都是正常结果", () => {
    const r = recordPlan(db, card({ candidates: [], holdings: [] }), "2026-08-04", "2026-08-04T09:15:00+08:00");
    expect(r).toMatchObject({ recorded: 0, skipped: false });
  });
});
