/**
 * 离场策略模拟器。
 *
 * 这里最要紧的一条测试不是"某个规则触发了"，而是**它必须与影子盘结算口径逐笔一致**
 * （与 settleShadow 对齐）。理由：
 *   影子盘所有历史样本的 net_pct 都是 settleShadow 算出来的，而本模块评测出来的
 *   每一项建议都要落到那些样本上做对比。两份实现一旦漂移，
 *   "优化出来的规则"和"被记账的那个规则"就不是同一个东西了 ——
 *   而且这种漂移不会报错，只会让配对差悄悄变得没有意义。
 *
 * 其余各条按"当日可判定"这条红线出题：只用截至今日的 K 线。
 */
import { describe, it, expect } from "vitest";
import type { DailyBar } from "@/lib/contracts";
import { DEFAULT_CONSTRAINTS } from "@/lib/contracts/backtest";
import { settleShadow } from "@/lib/shadow/settle";
import {
  现行, advanceExit, decideToday, dropRulesNeedingAge, newExitState, scalePath, simulateExit, stepExit,
  type ExitPolicy, type PathBar, type RawBar,
} from "@/lib/shadow/exit-policy";

/* ------------------------------- 造 K 线 ------------------------------- */

const D = (i: number): string => `2026-08-${String(3 + i).padStart(2, "0")}`;

function bar(code: string, i: number, o: number, h: number, l: number, c: number, adjFactor = 1): DailyBar {
  return { code, date: D(i), o, h, l, c, vol: 1e6, amount: 1e7, adjFactor };
}

/** PathBar 的简写：o/h/l/c 一致时只写价格 */
function flat(i: number, px: number, over: Partial<PathBar> = {}): PathBar {
  return { date: D(i), o: px, h: px, l: px, c: px, adjFactor: 1, ...over };
}

function box(i: number, o: number, h: number, l: number, c: number): PathBar {
  return { date: D(i), o, h, l, c, adjFactor: 1 };
}

/** 过完这一天。这里要的是收盘后的状态，所以只推状态、不走 stepExit 的离场判定 */
function 过完一天(p: ExitPolicy, st: ReturnType<typeof newExitState>, b: PathBar): void {
  advanceExit(p, st, b);
}

const NO = { slippage: 0, feeRate: 0 };

/* -------------------- 与 settleShadow 对齐（最重要的一组） -------------------- */

describe("与影子盘结算口径对齐", () => {
  /**
   * 只挑"安静走到期满"的路是测不出东西的 —— 必须包含跳空、同一天同时碰到两条线、
   * 一字跌停这些分支，那几处才是两份实现最容易写出不同答案的地方。
   */
  const cases: Array<{ name: string; bars: DailyBar[]; trigger: number; stop: number | null; target: number | null }> = [
    {
      name: "安静走到期满",
      bars: [bar("c", 0, 10, 10.2, 9.8, 10), bar("c", 1, 10.1, 10.5, 10, 10.4), bar("c", 2, 10.4, 10.8, 10.3, 10.7),
        bar("c", 3, 10.7, 11, 10.6, 10.9), bar("c", 4, 10.9, 11.2, 10.8, 11.1)],
      trigger: 10, stop: 9, target: null,
    },
    { name: "跳空低开穿透止损", bars: [bar("c", 0, 10, 10.2, 9.8, 10), bar("c", 1, 8.5, 8.8, 8.3, 8.6)], trigger: 10, stop: 9, target: null },
    { name: "跳空高开越过目标", bars: [bar("c", 0, 10, 10.2, 9.8, 10), bar("c", 1, 11.5, 11.6, 11.2, 11.4)], trigger: 10, stop: 9, target: 10.6 },
    { name: "同日同时碰到止损与目标", bars: [bar("c", 0, 10, 10.2, 9.8, 10), bar("c", 1, 10.1, 10.7, 8.8, 10.2)], trigger: 10, stop: 9, target: 10.6 },
    { name: "盘中触及目标", bars: [bar("c", 0, 10, 10.2, 9.8, 10), bar("c", 1, 10, 10.7, 9.9, 10.1)], trigger: 10, stop: 9, target: 10.6 },
    { name: "一字跌停后顺延", bars: [bar("c", 0, 10, 10.2, 9.8, 10), bar("c", 1, 8.1, 8.1, 8.1, 8.1), bar("c", 2, 7.5, 7.6, 7.3, 7.4)],
      trigger: 10, stop: 9, target: null },
    { name: "无止损无目标", bars: [bar("c", 0, 10, 10.2, 9.8, 10), bar("c", 1, 8, 8.2, 7.8, 8)], trigger: 10, stop: null, target: null },
  ];

  for (const c of cases) {
    it(`${c.name}：两份实现逐字段一致`, () => {
      const mine = simulateExit(现行, {
        path: scalePath(c.bars, 0), entryPx: c.trigger,
        planStopPx: c.stop, planTargetPx: c.target, ...NO,
      });
      const theirs = settleShadow(
        { triggerPx: c.trigger, stopPx: c.stop, targetPx: c.target }, c.bars, { horizon: 5, ...NO },
      );
      expect(mine.status).toBe(theirs.status);
      if (theirs.status !== "已结算") return;
      expect(mine.exitIdx).not.toBeNull();
      expect(c.bars[mine.exitIdx!].date).toBe(theirs.exitDate);
      expect(mine.reason).toBe(theirs.exitReason);
      expect(mine.netPct).toBeCloseTo(theirs.netPct!, 10);
    });
  }
});

/* ------------------------------- T+1 与天数计数 ------------------------------- */

describe("T+1 与到期计数", () => {
  it("成交当天不判定：只有一根 K 线时是待定，不是当场成交当场走", () => {
    const s = simulateExit(现行, { path: [flat(0, 10)], entryPx: 10, planStopPx: 1, planTargetPx: null, ...NO });
    expect(s.status).toBe("待定");
    expect(s.note).toBeTruthy();   // 待定必须带理由
  });

  it("到期 2 日：落在第 2 个交易日的收盘，不是第 1 个", () => {
    const path = [flat(0, 10), flat(1, 10), flat(2, 10)];
    const s = simulateExit({ ...现行, 到期: 2 }, { path, entryPx: 10, planStopPx: null, planTargetPx: null, ...NO });
    expect(s.status).toBe("已结算");
    expect(s.reason).toBe("期满");
    expect(s.held).toBe(2);
    expect(s.exitIdx).toBe(1);
  });

  it("到期 5 日：成交日算第 1 天，期满落在第 5 根（口径必须与 settleShadow 一致）", () => {
    const path = [0, 1, 2, 3, 4, 5].map(i => flat(i, 10));
    const s = simulateExit(现行, { path, entryPx: 10, planStopPx: null, planTargetPx: null, ...NO });
    expect(s.held).toBe(5);
    expect(s.exitIdx).toBe(4);
  });
});

/* --------------------------- 跳空：按开盘价成交 --------------------------- */

describe("跳空按开盘价成交，不按那条线", () => {
  const prev = flat(0, 10);

  it("向下跳空：成交在开盘价，比止损价更差", () => {
    const st = newExitState(现行, 10, 9, null);
    const d = stepExit(现行, st, box(1, 8.5, 8.8, 8.3, 8.6), 10, [prev]);
    expect(d.走).toBe(true);
    expect(d.px).toBe(8.5);   // 不是 9 —— 按线成交会把跳空低开的亏损记少
    expect(d.reason).toBe("止损");
  });

  it("向上跳空：同样按开盘价，可能好于目标价", () => {
    const pol: ExitPolicy = { ...现行, 目标: 6 };
    const st = newExitState(pol, 10, null, null);
    const d = stepExit(pol, st, box(1, 11.5, 11.6, 11.2, 11.4), 10, [prev]);
    expect(d.走).toBe(true);
    expect(d.px).toBe(11.5);
    expect(d.reason).toBe("目标");
  });
});

/* ----------------------------- 移动止损：只用过去 ----------------------------- */

describe("移动止损", () => {
  const pol: ExitPolicy = { ...现行, 到期: 10, 移动止损: { 起: 5, 回撤: 3 } };

  it("没够到触发线之前，止损不抬", () => {
    const st = newExitState(pol, 100, null, null);
    过完一天(pol, st, box(1, 100, 104, 99, 103));   // 峰值 104 = +4% < 5%
    expect(st.stopLvl).toBeNull();
  });

  it("够到之后抬到 峰值×(1−回撤)，且只抬不降", () => {
    const st = newExitState(pol, 100, null, null);
    过完一天(pol, st, box(1, 100, 107, 99, 106));   // 峰值 107 ≥ +5%
    expect(st.stopLvl).toBeCloseTo(107 * 0.97, 10);
    const first = st.stopLvl!;
    过完一天(pol, st, box(2, 105, 105.5, 100, 105)); // 没创新高 → 不动
    expect(st.stopLvl).toBe(first);
    过完一天(pol, st, box(3, 105, 112, 104, 111));   // 新高 → 再抬
    expect(st.stopLvl).toBeCloseTo(112 * 0.97, 10);
  });

  it("当天的峰值不参与当天的判定 —— 只能用昨天的", () => {
    const pol3: ExitPolicy = { ...现行, 到期: 10, 移动止损: { 起: 3, 回撤: 3 } };
    const path = [flat(0, 100), box(1, 100, 104, 100, 103)];
    const st = newExitState(pol3, 100, null, null);
    expect(st.stopLvl).toBeNull();                       // 判定前还没有移动止损位
    const d = stepExit(pol3, st, path[1], 100, [path[0]]);
    expect(d.走).toBe(false);
    过完一天(pol3, st, path[1]);
    expect(st.peak).toBe(104);
    expect(st.stopLvl).toBeCloseTo(104 * 0.97, 10);
  });
});

/* --------------------------- 收盘类规则在盘中不判 --------------------------- */

describe("盘中只用价格线", () => {
  const path = [flat(0, 10), box(1, 9.5, 9.6, 9.3, 9.4), box(2, 9.2, 9.3, 9.0, 9.1)];
  const pol: ExitPolicy = { ...现行, 到期: 2, 破均线: 2, 时间止损: { 第几日: 2, 低于: 0 } };

  it("盘后：到期 / 破均线 / 时间止损都算数", () => {
    expect(decideToday(pol, { path, entryPx: 10, planStopPx: null, planTargetPx: null, ...NO }).走).toBe(true);
  });

  it("盘中：收盘类规则不判，当日没破价就继续持有", () => {
    const d = decideToday(pol, { path, entryPx: 10, planStopPx: null, planTargetPx: null, ...NO, 盘中: true });
    expect(d.走).toBe(false);
  });

  it("盘中：价格到了照样走 —— 不是把整个槽关掉", () => {
    const upPol: ExitPolicy = { ...现行, 目标: 3 };
    const up = [flat(0, 10), box(1, 10.4, 10.5, 10.3, 10.45)];
    const d = decideToday(upPol, { path: up, entryPx: 10, planStopPx: null, planTargetPx: null, ...NO, 盘中: true });
    expect(d.走).toBe(true);
    expect(d.reason).toBe("目标");
  });
});

/* ------------------------ 缺 openDate：必须关掉并报出来 ------------------------ */

describe("缺建仓日时不许退化成第 1 天", () => {
  it("需要天数的规则被剔除并列出名字，不需要的不牵连", () => {
    const pol: ExitPolicy = { ...现行, 到期: 4, 时间止损: { 第几日: 3, 低于: 0 }, 破均线: 5 };
    const { pol: out, dropped } = dropRulesNeedingAge(pol);
    expect(dropped).toContain("持有上限");
    expect(dropped).toContain("时间止损");
    expect(dropped).not.toContain("破均线");
    expect(out.时间止损).toBeNull();
    expect(out.到期).toBe(Number.MAX_SAFE_INTEGER); // 不是 0 —— 0 会被理解成"当天到期"
    expect(out.破均线).toBe(5);
  });

  it("本来没配天数规则时不告警 —— 静默与否必须有区别", () => {
    // 注意：现行本身**是**带 5 日期满的，所以它确实需要 openDate。
    // 这里要验的是"没配天数规则时不产生噪音"，得用一个明确不带天数规则的 policy。
    const 无上限: ExitPolicy = { ...现行, 到期: Number.MAX_SAFE_INTEGER };
    expect(dropRulesNeedingAge(无上限).dropped).toEqual([]);
    expect(dropRulesNeedingAge(现行).dropped).toContain("持有上限");
  });
});

/* ------------------------------ 复权口径 ------------------------------ */

describe("scalePath 的基准", () => {
  it("基准取指定下标，而不是窗口第一根", () => {
    const raw = [bar("c", 0, 20, 21, 19, 20, 2), bar("c", 1, 20, 21, 19, 20, 1)];
    expect(scalePath(raw, 0)[1].c).toBeCloseTo(10, 10);   // 以第 0 根为基准 → 第 1 根 ×1/2
    expect(scalePath(raw, 1)[0].c).toBeCloseTo(40, 10);   // 以第 1 根为基准 → 第 0 根 ×2
    expect(scalePath(raw, 1)[1].c).toBeCloseTo(20, 10);
  });

  it("基准必须是成交日那一根（窗口从入场日之前开始时）", () => {
    // 窗口里有三根，成交日是第 1 根——用它做基准时，成交日当天价格必须原样保留
    const raw: RawBar[] = [
      { date: "2026-08-01", o: 50, h: 50, l: 50, c: 50, adjFactor: 2.5 },
      { date: "2026-08-02", o: 20, h: 20, l: 20, c: 20, adjFactor: 1 },
    ];
    expect(scalePath(raw, 1)[1].c).toBeCloseTo(20, 10);
  });

  it("adjFactor 缺失当 1，不炸", () => {
    expect(scalePath([{ date: "2026-08-03", o: 10, h: 10, l: 10, c: 10 }])[0].c).toBe(10);
  });
});

/* ------------------------------ 成本口径 ------------------------------ */

describe("成本与影子盘同口径", () => {
  it("含成本时两边仍然一致", () => {
    const bars = [bar("c", 0, 10, 10.2, 9.8, 10), bar("c", 1, 10, 11.5, 9.9, 10.6)];
    const o = { slippage: DEFAULT_CONSTRAINTS.slippage, feeRate: DEFAULT_CONSTRAINTS.feeRate };
    const mine = simulateExit({ ...现行, 目标: 5 }, {
      path: scalePath(bars, 0), entryPx: 10, planStopPx: null, planTargetPx: null, ...o,
    });
    const theirs = settleShadow({ triggerPx: 10, stopPx: null, targetPx: 10.5 }, bars, { horizon: 5, ...o });
    expect(mine.netPct).toBeCloseTo(theirs.netPct!, 10);
  });
});
