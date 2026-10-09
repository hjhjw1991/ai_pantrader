import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { resolvePx } from "@/lib/ledger/reconcile";
import { makeTempDb, insDaily, type TempDb } from "./pit/helpers";

let t: TempDb;
beforeEach(() => { t = makeTempDb(); });
afterEach(() => { t.close(); });

describe("resolvePx 读侧修复坏复权因子", () => {
  it("非 1 台阶之后写坏的 1.0 顺延前值，基准价与结算价在同一尺度", () => {
    insDaily(t.db, "600667", "2026-09-01", 19.4, { adj: 5.8 });
    insDaily(t.db, "600667", "2026-09-02", 19.6, { adj: 1 });   // 坏行
    expect(resolvePx(t.db, "600667", "2026-09-01")!.px).toBeCloseTo(19.4 * 5.8, 6);
    expect(resolvePx(t.db, "600667", "2026-09-02")!.px).toBeCloseTo(19.6 * 5.8, 6);
  });

  it("从没除过权的票整段 1.0，不被误判", () => {
    insDaily(t.db, "000001", "2026-09-01", 10, { adj: 1 });
    insDaily(t.db, "000001", "2026-09-02", 11, { adj: 1 });
    expect(resolvePx(t.db, "000001", "2026-09-02")!.px).toBe(11);
  });
});
