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

  it("瞬时故障重试：回滚掉的那次写入不计入 recorded", () => {
    // 第二只候选第一次读 size 时抛瞬时错 —— 此时第一只已经 insert 并计数，事务随后回滚；
    // 重试成功后 recorded 必须是 2，不是 3
    let thrown = false;
    const flaky = { ...buy("600002") } as any;
    Object.defineProperty(flaky, "size", {
      get() { if (!thrown) { thrown = true; throw new Error("SQLITE_BUSY: database is locked"); } return 0.1; },
      enumerable: true,
    });
    const variants = [{ id: "a", name: "a", slots: {} }];
    const r = runShadowDay(t.db, opts(() => () => card([buy("600001"), flaky]), { variants }));
    expect(thrown).toBe(true);
    expect(r.failed).toEqual([]);
    expect(rows()).toHaveLength(2);
    expect(r.recorded).toBe(2);
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

  it("结算按修复后的复权因子：非 1 台阶之后写坏的 1.0 不会把目标价离场算成止损", () => {
    seed();
    insDaily(t.db, "600001", DAYS[0], 10, { adj: 2 });                       // 基准日
    insDaily(t.db, "600001", DAYS[1], 10.1, { o: 10, h: 10.2, l: 9.9, adj: 2 }); // 成交日
    // 之后几天 daemon 写坏成 1.0：不修的话这些价按 ×1/2 换到成交日尺度，11 变 5.5 → 止损
    insDaily(t.db, "600001", DAYS[2], 11, { o: 10.2, h: 11.3, l: 10.1, adj: 1 });
    for (const d of DAYS.slice(3, 6)) insDaily(t.db, "600001", d, 11, { adj: 1 });
    const r = settleShadowPending(t.db, "2026-09-08");
    expect(r.settled).toBe(1);
    expect(outcome()[0]).toMatchObject({ status: "已结算", exit_reason: "目标", exit_px: 11 });
  });

  it("哨兵行不结算", () => {
    runShadowDay(t.db, opts(() => () => card([], "防守"), { variants: [{ id: "a", name: "a", slots: {} }] }));
    expect(settleShadowPending(t.db, "2026-09-08")).toEqual({ settled: 0, untriggered: 0, pending: 0, voided: 0, failed: 0 });
  });

  /* ---------- 晚决策作废（用户 2026-10-09 选定）与进场方式 ---------- */

  const variants = [{ id: "a", name: "a", slots: {} }];
  const fullPath = () =>
    fill("600001", [[10, 10.2, 9.9, 10.1], [10.2, 11.3, 10.1, 11], [11, 11, 11, 11], [11, 11, 11, 11], [11, 11, 11, 11]]);

  it("决策时刻落库的是视图时点（asOf），不是写库挂钟；进场方式随候选落库", () => {
    runShadowDay(t.db, opts(() => () => card([buy("600001"), buy("600002", { entryType: "突破" })]), { variants }));
    const r = rows();
    expect(r.map(x => x.decided_at)).toEqual(["2026-09-02 09:15:00", "2026-09-02 09:15:00"]);
    expect(r.map(x => x.entry_type)).toEqual(["低吸", "突破"]);
  });

  it("盘前计划补跑到 11:00（晚于成交日 09:25）→ 作废，不管当天行情多好", () => {
    runShadowDay(t.db, opts(() => () => card([buy("600001", { targetPx: 11 })]), { variants, asOf: "2026-09-02 11:00:00" }));
    fullPath();
    const r = settleShadowPending(t.db, "2026-09-08");
    expect(r).toMatchObject({ voided: 1, settled: 0, untriggered: 0 });
    expect(outcome()[0]).toMatchObject({ status: "作废", entry_px: null, net_pct: null, exit_reason: null });
    expect(outcome()[0].note).toContain("决策晚于成交日 09:25");
  });

  it("恰好 09:25:00 也算晚（集合竞价已撮合）；09:24:59 不算", () => {
    runShadowDay(t.db, opts(() => () => card([buy("600001")]), { variants, asOf: "2026-09-02 09:25:00" }));
    runShadowDay(t.db, opts(() => () => card([buy("600001")]), {
      variants: [{ id: "b", name: "b", slots: {} }], asOf: "2026-09-02 09:24:59" }));
    fullPath();
    settleShadowPending(t.db, "2026-09-08");
    const by = Object.fromEntries((t.db.prepare(
      "SELECT p.variant_id v, o.status s FROM shadow_pred p JOIN shadow_outcome o ON o.pred_id = p.id").all() as any[])
      .map(x => [x.v, x.s]));
    expect(by).toEqual({ a: "作废", b: "已结算" });
  });

  it("已经按老口径结算过的晚决策：下次结算原地改判作废（幂等，只改一次）", () => {
    runShadowDay(t.db, opts(() => () => card([buy("600001", { targetPx: 11 })]), { variants, asOf: "2026-09-02 11:00:00" }));
    fullPath();
    // 模拟 028 之前落定的老结算
    t.db.prepare(`INSERT INTO shadow_outcome (pred_id, status, entry_date, entry_px, exit_date, exit_px, exit_reason, net_pct, settled_at)
      SELECT id, '已结算', '2026-09-02', 10, '2026-09-03', 11, '目标', 9.5, 'x' FROM shadow_pred`).run();
    expect(settleShadowPending(t.db, "2026-09-08").voided).toBe(1);
    expect(outcome()[0]).toMatchObject({ status: "作废", entry_px: null, exit_px: null, net_pct: null });
    expect(settleShadowPending(t.db, "2026-09-09").voided).toBe(0);
  });

  it("老行没有 decided_at（旧备份导入）：live 按 created_at 兜底判，replay 按基准日 15:05 不会被误判", () => {
    runShadowDay(t.db, opts(() => () => card([buy("600001")]), { variants }));
    runShadowDay(t.db, opts(() => () => card([buy("600001")]), { variants, source: "replay", asOf: "2026-09-01 15:05:00" }));
    // 回放的 created_at 是回放那天的挂钟（远晚于成交日）—— 拿它判会把回放全判作废
    t.db.prepare("UPDATE shadow_pred SET decided_at = NULL, created_at = '2026-10-01 20:00:00.000'").run();
    fullPath();
    settleShadowPending(t.db, "2026-09-08");
    const by = Object.fromEntries((t.db.prepare(
      "SELECT p.source v, o.status s FROM shadow_pred p JOIN shadow_outcome o ON o.pred_id = p.id").all() as any[])
      .map(x => [x.v, x.s]));
    expect(by).toEqual({ live: "作废", replay: "已结算" });
  });

  it("晚决策当天 0 候选的哨兵行也作废：那天整天不算跑过", () => {
    runShadowDay(t.db, opts(() => () => card([], "防守"), { variants, asOf: "2026-09-02 10:00:00" }));
    expect(settleShadowPending(t.db, "2026-09-08").voided).toBe(1);
    expect(outcome()[0]).toMatchObject({ pred_id: "2026-09-01:a:live:-", status: "作废" });
  });

  it("突破单：成交日最高价够不到触发价 → 未触发；按低吸撮合的话这笔会在开盘成交", () => {
    runShadowDay(t.db, opts(() => () => card([buy("600001", { triggerPx: 11, stopPx: 10.5, entryType: "突破" })]), { variants }));
    fill("600001", [[10, 10.8, 9.9, 10.5], [10.5, 10.6, 10.4, 10.5], [10.5, 10.6, 10.4, 10.5], [10.5, 10.6, 10.4, 10.5], [10.5, 10.6, 10.4, 10.5]]);
    expect(settleShadowPending(t.db, "2026-09-08")).toMatchObject({ untriggered: 1, settled: 0 });
  });

  it("突破单：摸到触发价 → 按 max(开盘, 触发价) 成交", () => {
    runShadowDay(t.db, opts(() => () => card([buy("600001", { triggerPx: 10.5, stopPx: 9.5, entryType: "突破" })]), { variants }));
    fill("600001", [[10, 10.8, 9.9, 10.6], [10.6, 10.7, 10.5, 10.6], [10.6, 10.7, 10.5, 10.6], [10.6, 10.7, 10.5, 10.6], [10.6, 10.7, 10.5, 10.6]]);
    expect(settleShadowPending(t.db, "2026-09-08").settled).toBe(1);
    expect(outcome()[0]).toMatchObject({ status: "已结算", entry_px: 10.5 });
  });
});
