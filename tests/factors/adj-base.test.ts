import { describe, it, expect } from "vitest";
import { baseAdjFactor, repairAdjFactorSeries } from "@/lib/factors/util";

/**
 * 复权因子的两条读侧规则。
 *
 * 背景（2026-09-30 复发）：常驻采集进程的代码冻结在它启动那一刻，
 * 于是每天新插进来的那一根是上一版逻辑写的 —— adj_factor 全是 1.0。
 * 前复权价 = 后复权价 ÷ 基准因子，基准错了是**整张图全错**（历史按 5.8 倍显示），
 * 而且错得很像"这票以前很贵"，看盘的人不会怀疑。
 *
 * 写侧的自愈（repairTrailingAdjFactors）修的是库；这两条修的是"库还没修好之前"
 * 的读取窗口。两条都要在，缺一条这段窗口就还是错的。
 */
const bar = (date: string, f: number | null, c = 10) => ({ code: "600000", date, c, adjFactor: f });

describe("baseAdjFactor（前复权归一基准）", () => {
  it("正常序列取最后一根 —— 因子是随日期单调递增的台阶", () => {
    expect(baseAdjFactor([bar("2026-09-24", 5.47), bar("2026-09-25", 5.8)])).toBe(5.8);
  });

  it("最后一根被写成 1.0 时，基准落到上一根 —— 这正是那次事故的形状", () => {
    expect(baseAdjFactor([bar("2026-09-24", 5.8), bar("2026-09-29", 1)])).toBe(5.8);
  });

  it("从没除过权的票整段都是 1.0，基准就是 1 —— 不会被误判", () => {
    expect(baseAdjFactor([bar("2026-09-24", 1), bar("2026-09-29", 1)])).toBe(1);
  });

  it("因子落在回暖之前：第一根就该是 1 的早期行不受后面影响", () => {
    expect(baseAdjFactor([bar("2022-05-18", 1), bar("2026-09-24", 5.8)])).toBe(5.8);
  });

  /** NULL / NaN 不能污染基准，也不能让画面显示出 NaN */
  it("因子缺失的行按 0 处理，不参与取最大", () => {
    expect(baseAdjFactor([bar("a", null), bar("b", NaN), bar("c", 3)])).toBe(3);
  });

  it("一根可用因子都没有时返回 0，而不是退化成 1", () => {
    expect(baseAdjFactor([bar("a", null)])).toBe(0);
    expect(baseAdjFactor([])).toBe(0);
  });
});

describe("repairAdjFactorSeries（读侧顺延）", () => {
  it("把非 1 台阶之后的 1.0 顺延成前一交易日的因子", () => {
    const out = repairAdjFactorSeries([bar("2026-09-24", 5.8), bar("2026-09-29", 1)]);
    expect(out.map(b => b.adjFactor)).toEqual([5.8, 5.8]);
  });

  it("连续多根被写坏也能一路顺延", () => {
    const out = repairAdjFactorSeries([bar("a", 5.8), bar("b", 1), bar("c", 1)]);
    expect(out.map(b => b.adjFactor)).toEqual([5.8, 5.8, 5.8]);
  });

  it("幂等：已经正确的序列一字不改（连元素引用都不换）", () => {
    const src = [bar("a", 5.47), bar("b", 5.8)];
    const out = repairAdjFactorSeries(src);
    expect(out).toBe(src);                       // 没发生变化时不复制数组
    expect(out[0]).toBe(src[0]);
  });

  it("真没除过权的票（整段 1.0）不动", () => {
    const out = repairAdjFactorSeries([bar("a", 1), bar("b", 1)]);
    expect(out.map(b => b.adjFactor)).toEqual([1, 1]);
  });

  /** 首根之前没有参照，不能凭空发明一个因子出来 */
  it("序列开头就是 1 不动 —— 那一行可能真的在首次除权之前", () => {
    const out = repairAdjFactorSeries([bar("a", 1), bar("b", 1), bar("c", 5.8)]);
    expect(out.map(b => b.adjFactor)).toEqual([1, 1, 5.8]);
  });

  it("只改坏行那一根，其余元素保持原引用（省热路径上的复制）", () => {
    const src = [bar("a", 5.8), bar("b", 1)];
    const out = repairAdjFactorSeries(src);
    expect(out[0]).toBe(src[0]);
    expect(out[1]).not.toBe(src[1]);
    expect(out[1].adjFactor).toBe(5.8);
  });

  it("不该动到价格与量，只碰因子", () => {
    const out = repairAdjFactorSeries([{ ...bar("a", 5.8, 17.9), vol: 123 }, bar("b", 1, 17.5)!]);
    expect(out.map(b => b.c)).toEqual([17.9, 17.5]);
    expect((out[0] as { vol?: number }).vol).toBe(123);
  });

  it("NULL 因子按 1 处理后再参与判断", () => {
    const out = repairAdjFactorSeries([bar("a", 5.8), bar("b", null)]);
    expect(out.map(b => b.adjFactor)).toEqual([5.8, 5.8]);
  });
});
