import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { replayShadow } from "@/lib/shadow/replay";
import { variantReports } from "@/lib/shadow/report";
import { makeTempDb, insDaily, insSecurity, insCalendar, type TempDb } from "../pit/helpers";
import { config } from "../strategy/helpers";

let t: TempDb;
const DAYS = ["2026-09-01", "2026-09-02", "2026-09-03", "2026-09-04", "2026-09-07", "2026-09-08", "2026-09-09", "2026-09-10", "2026-09-11"];
beforeEach(() => {
  t = makeTempDb(); insCalendar(t.db, DAYS); insSecurity(t.db, "600001");
  // 每天平开、盘中下探到 9.9、收在 10.2：触发价 10 次日必成交，第 5 天收盘期满
  for (const d of DAYS) insDaily(t.db, "600001", d, 10.2, { o: 10, h: 10.3, l: 9.9 });
});
afterEach(() => { t.close(); });

/** baseline 每天出一只；pricing 只在 09-02 出一只 */
const engineFor = (slots: any) => (input: any) => {
  const d = input.view.asOf.slice(0, 10);
  const want = slots.评估器 ? d === "2026-09-02" : true;
  return { env: { gear: "中性" }, candidates: want ? [{ code: "600001", name: "x", action: "买入", account: "卫星", triggerPx: 10, stopPx: 9, size: 0.1 }] : [] };
};

describe("replayShadow", () => {
  it("逐日回放 → 记录 → 结算；报表按变体出成绩单并对 baseline 做 t 检验", () => {
    const r = replayShadow(t.db, { from: "2026-09-01", to: "2026-09-03", config: config(), settleAsOf: "2026-09-11", engineFor });
    expect(r.days).toBe(3);
    expect(r.failed).toEqual([]);
    expect(r.settle.settled).toBeGreaterThan(0);
    const rep = variantReports(t.db, "replay");
    const base = rep.find(x => x.id === "baseline")!;
    expect(base.summary.settled).toBe(3);
    expect(base.days).toBe(3);
    expect(base.vsBaseline).toBeNull();
    expect(rep.find(x => x.id === "pricing")!.summary.settled).toBe(1);
  });

  it("可中断：再跑一遍，已完成的日子整天跳过", () => {
    replayShadow(t.db, { from: "2026-09-01", to: "2026-09-03", config: config(), settleAsOf: "2026-09-11", engineFor });
    const r = replayShadow(t.db, { from: "2026-09-01", to: "2026-09-04", config: config(), settleAsOf: "2026-09-11", engineFor });
    expect(r.skippedDays).toBe(3);
    expect(r.recorded).toBeGreaterThan(0);   // 只有 09-04 是新的
  });

  it("回放样本与实盘样本分开统计", () => {
    replayShadow(t.db, { from: "2026-09-01", to: "2026-09-02", config: config(), settleAsOf: "2026-09-11", engineFor });
    expect(variantReports(t.db, "live").find(x => x.id === "baseline")!.summary.settled).toBe(0);
  });
});
