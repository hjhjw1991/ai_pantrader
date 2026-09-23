import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { seedVariants, activeVariants, runShadowDay, settleShadowPending } from "@/lib/shadow/book";
import { DEFAULT_VARIANTS } from "@/lib/shadow/variants";
import { makeTempDb, insDaily, insSecurity, insCalendar, type TempDb } from "../pit/helpers";
import { config } from "../strategy/helpers";

let t: TempDb;
const DAYS = ["2026-09-01", "2026-09-02", "2026-09-03", "2026-09-04", "2026-09-07", "2026-09-08", "2026-09-09"];
beforeEach(() => { t = makeTempDb(); insCalendar(t.db, DAYS); insSecurity(t.db, "600001"); });
afterEach(() => { t.close(); });

const card = (cands: any[], gear = "中性", stage?: string) => ({
  env: { gear }, candidates: cands, ...(stage ? { stage } : {}),
});
const buy = (code: string, over: Record<string, unknown> = {}) => ({
  code, name: code, action: "买入", account: "卫星", triggerPx: 10, stopPx: 9.5, size: 0.1, score: 1, ...over,
});
const opts = (engineFor: any, over: Record<string, unknown> = {}) => ({
  decidedOn: "2026-09-02", baseDate: "2026-09-01", asOf: "2026-09-02 09:15:00", phase: "盘前" as const,
  config: config(), source: "live" as const, engineFor, ...over,
});
const rows = () => t.db.prepare("SELECT * FROM shadow_pred ORDER BY id").all() as any[];

describe("变体登记", () => {
  it("首次登记默认变体；再登记不覆盖已有定义（样本按 id 归因，定义不能被悄悄改）", () => {
    expect(seedVariants(t.db)).toBe(DEFAULT_VARIANTS.length);
    t.db.prepare("UPDATE shadow_variant SET slot_config = '{\"x\":1}' WHERE id = 'pricing'").run();
    expect(seedVariants(t.db)).toBe(0);
    expect(activeVariants(t.db).find(v => v.id === "pricing")!.slots).toEqual({ x: 1 });
  });
  it("退役的变体不再跑", () => {
    seedVariants(t.db);
    t.db.prepare("UPDATE shadow_variant SET status = 'retired' WHERE id = 'cycle'").run();
    expect(activeVariants(t.db).map(v => v.id)).not.toContain("cycle");
  });
});

describe("runShadowDay", () => {
  it("每个变体各出一张卡，只记买入候选，带目标价 / 盈亏比 / 阶段", () => {
    const variants = [{ id: "a", name: "a", slots: {} }, { id: "b", name: "b", slots: { 评估器: { 用: "x" } } }];
    const r = runShadowDay(t.db, opts((slots: any) => () => slots.评估器
      ? card([buy("600001", { targetPx: 11, rrRatio: 2 }), { ...buy("600002"), action: "观察" }], "进攻", "发酵")
      : card([buy("600001")]), { variants }));
    expect(r).toMatchObject({ variants: 2, recorded: 2, failed: [] });
    const b = rows().find(x => x.variant_id === "b")!;
    expect(b).toMatchObject({ target_px: 11, rr_ratio: 2, stage: "发酵", gear: "进攻", base_date: "2026-09-01" });
    expect(rows().find(x => x.variant_id === "a")!.target_px).toBeNull();
  });

  it("幂等：同一变体同一天重跑不重复记", () => {
    const variants = [{ id: "a", name: "a", slots: {} }];
    const eng = () => () => card([buy("600001")]);
    runShadowDay(t.db, opts(eng, { variants }));
    const r = runShadowDay(t.db, opts(eng, { variants }));
    expect(r.skipped).toEqual(["a"]);
    expect(rows()).toHaveLength(1);
  });

  it("0 候选也留一条哨兵行：'判了防守没候选'与'那天没跑'要分得开", () => {
    const variants = [{ id: "a", name: "a", slots: {} }];
    runShadowDay(t.db, opts(() => () => card([], "防守"), { variants }));
    expect(rows()).toMatchObject([{ code: "-", gear: "防守" }]);
    expect(runShadowDay(t.db, opts(() => () => card([], "防守"), { variants })).skipped).toEqual(["a"]);
  });

  it("一个变体抛错不拖累其他变体", () => {
    const variants = [{ id: "bad", name: "bad", slots: { x: 1 } as any }, { id: "ok", name: "ok", slots: {} }];
    const r = runShadowDay(t.db, opts((s: any) => () => { if (s.x) throw new Error("boom"); return card([buy("600001")]); }, { variants }));
    expect(r.failed).toEqual([{ variant: "bad", error: "boom" }]);
    expect(rows().map(x => x.variant_id)).toEqual(["ok"]);
  });
});

describe("settleShadowPending", () => {
  const seed = (code = "600001", tgt: number | null = 11) => {
    runShadowDay(t.db, opts(() => () => card([buy(code, { targetPx: tgt })]), { variants: [{ id: "a", name: "a", slots: {} }] }));
  };
  const fill = (code: string, px: Array<[number, number, number, number]>, from = 1) =>
    px.forEach(([o, h, l, c], i) => insDaily(t.db, code, DAYS[from + i], c, { o, h, l }));
  const outcome = () => t.db.prepare("SELECT * FROM shadow_outcome").all() as any[];
  const padMarket = (d: string) => { for (let i = 0; i < 1000; i++) insDaily(t.db, `9${String(i).padStart(5, "0")}`, d, 1); };

  it("走完持有期按目标价离场", () => {
    seed();
    fill("600001", [[10, 10.2, 9.9, 10.1], [10.2, 11.3, 10.1, 11], [11, 11, 11, 11], [11, 11, 11, 11], [11, 11, 11, 11]]);
    const r = settleShadowPending(t.db, "2026-09-08");
    expect(r.settled).toBe(1);
    expect(outcome()[0]).toMatchObject({ status: "已结算", exit_reason: "目标", exit_px: 11 });
  });

  it("持有期没走完 → 待定，不落表", () => {
    seed();
    fill("600001", [[10, 10.2, 9.9, 10.1], [10.1, 10.2, 10, 10.1]]);
    expect(settleShadowPending(t.db, "2026-09-03")).toMatchObject({ pending: 1, settled: 0 });
    expect(outcome()).toEqual([]);
  });

  it("成交日只有它没有 K 线 → 停牌，未触发", () => {
    seed();
    padMarket(DAYS[1]);
    fill("600001", [[10, 10.2, 9.9, 10.1]], 2);
    settleShadowPending(t.db, "2026-09-08");
    expect(outcome()[0]).toMatchObject({ status: "未触发", note: "成交日停牌" });
  });

  it("成交日全市场都没 K 线 → 日线没采到，待定", () => {
    seed();
    expect(settleShadowPending(t.db, "2026-09-08").pending).toBe(1);
    expect(outcome()).toEqual([]);
  });

  it("结算一旦落定不再改（只追加）", () => {
    seed();
    fill("600001", [[10, 10.2, 9.9, 10.1], [10.2, 11.3, 10.1, 11], [11, 11, 11, 11], [11, 11, 11, 11], [11, 11, 11, 11]]);
    settleShadowPending(t.db, "2026-09-08");
    expect(settleShadowPending(t.db, "2026-09-09").settled).toBe(0);
    expect(outcome()).toHaveLength(1);
  });

  it("哨兵行不结算", () => {
    runShadowDay(t.db, opts(() => () => card([], "防守"), { variants: [{ id: "a", name: "a", slots: {} }] }));
    expect(settleShadowPending(t.db, "2026-09-08")).toEqual({ settled: 0, untriggered: 0, pending: 0 });
  });
});
