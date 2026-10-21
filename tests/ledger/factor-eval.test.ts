import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { Db } from "@/lib/db";
import type { Action } from "@/lib/contracts";
import {
  MIN_OBS, crossSectionIc, envTimeSeriesIc, evalFactorIc, evalFactorQuantiles,
  loadFactorObs, pearson, ranks, spearman,
} from "@/lib/ledger/factor-eval";
import { cleanup, insertPredRow, mkPred, seedCalendar, seedDaily, tmpDb, weekdays } from "./helpers";

let db: Db, dir: string, days: string[];
beforeEach(() => {
  ({ db, dir } = tmpDb());
  days = weekdays("2026-08-03", 60);
  seedCalendar(db, days);
});
afterEach(() => cleanup(db, dir));

const F = "量能";
/** 决策日索引间隔 6、horizon 5 → 各期窗口互不重叠，价格可以逐个窗口单独铺 */
const H = 5;
const CODES = ["000001", "000002", "000003", "000004"];
/** 分组检验要每组多只票才看得出"头部失效"，所以另备 10 只 */
const CODES10 = ["000001", "000002", "000003", "000004", "000005",
  "000006", "000007", "000008", "000009", "000010"];

/**
 * 铺一条观测：决策日 days[di]（盘后）→ 第 5 个交易日 days[di+H]，
 * 因子值 v，该票这段的涨跌幅 retPct。
 */
function seedObs(di: number, code: string, v: number, retPct: number, opts: {
  factor?: string; scope?: "stock" | "env"; value?: number | null;
  action?: Action; verdict?: string; dirty?: string | null;
} = {}): string {
  const base = days[di], end = days[di + H];
  seedDaily(db, code, [
    { date: base, c: 10 },
    { date: end, c: 10 * (1 + retPct / 100) },
  ]);
  const action = opts.action ?? "买入";
  const id = `${base}:s1:${code}:${action}`;
  insertPredRow(db, mkPred({
    id, ts: `${base}T15:30:00+08:00`, phase: "盘后", code, action,
    evalHorizon: H, validUntil: end, triggerPx: null, stopPx: null,
  }));
  db.prepare(
    `INSERT OR REPLACE INTO prediction_factor
       (pred_id, factor_name, scope, version, value, label, confidence, created_at)
     VALUES (?, ?, ?, '1', ?, NULL, 1, ?)`
    // value 显式传 null 表示定性因子（只有 label 没有数值），不能用 ?? 否则会回退成 v
  ).run(id, opts.factor ?? F, opts.scope ?? "stock",
    opts.value !== undefined ? opts.value : v, `${base}T15:30:00+08:00`);
  db.prepare(
    `INSERT OR REPLACE INTO outcome (pred_id, verdict, actual_pct, error_type, attribution, settled_at, dirty_reason)
     VALUES (?, ?, ?, NULL, 't', ?, ?)`
  ).run(id, opts.verdict ?? "命中", retPct, `${end}T15:30:00+08:00`, opts.dirty ?? null);
  return id;
}

describe("ledger/factor-eval 秩相关基元", () => {
  it("并列取平均秩，不是随便挑一个名次", () => {
    expect(ranks([3, 1, 1, 2])).toEqual([4, 1.5, 1.5, 3]);
  });

  it("完全同序 = 1，完全逆序 = -1", () => {
    expect(spearman([1, 2, 3, 4], [10, 20, 30, 40])).toBeCloseTo(1, 9);
    expect(spearman([1, 2, 3, 4], [40, 30, 20, 10])).toBeCloseTo(-1, 9);
  });

  it("全并列时返回 null，绝不返回 0 冒充「无关」", () => {
    // 环境因子在一个横截面内全是同一个值，秩相关无定义
    expect(spearman([5, 5, 5, 5], [1, 2, 3, 4])).toBeNull();
    expect(pearson([5, 5, 5, 5], [1, 2, 3, 4])).toBeNull();
  });

  it("样本不足 3 条时不给相关系数", () => {
    expect(pearson([1, 2], [3, 4])).toBeNull();
  });
});

describe("ledger/factor-eval 横截面 IC", () => {
  it("只在同一天的横截面内算，不把不同日期的样本混在一起", () => {
    // 同一天：因子值与收益完全同序 → IC = 1
    for (let c = 0; c < 4; c++) seedObs(0, CODES[c], c + 1, (c + 1) * 2);
    const obs = loadFactorObs(db, F, "stock");
    expect(obs).toHaveLength(4);
    const { ics, nObs } = crossSectionIc(obs);
    expect(ics).toHaveLength(1);
    expect(ics[0]).toBeCloseTo(1, 9);
    expect(nObs).toBe(4);
  });

  it("横截面不足 3 只票就不算 —— 2 只的秩相关恒为 ±1，是纯噪声", () => {
    seedObs(0, CODES[0], 1, 2);
    seedObs(0, CODES[1], 2, 4);
    expect(crossSectionIc(loadFactorObs(db, F, "stock")).ics).toEqual([]);
  });

  it("不同 horizon 不混进同一个横截面", () => {
    for (let c = 0; c < 4; c++) seedObs(0, CODES[c], c + 1, (c + 1) * 2);
    // 把其中一条改成 D1：它的前瞻收益是另一把尺子，不该和 D5 的排在同一个秩里
    db.prepare("UPDATE prediction SET eval_horizon = 1 WHERE id = ?")
      .run(`${days[0]}:s1:${CODES[0]}:买入`);
    seedDaily(db, CODES[0], [{ date: days[1], c: 10 }]);
    const { ics } = crossSectionIc(loadFactorObs(db, F, "stock"));
    // D5 只剩 3 只（仍同序），D1 只有 1 只（不成截面）
    expect(ics).toHaveLength(1);
    expect(ics[0]).toBeCloseTo(1, 9);
  });

  it("样本量不足 30 时 verdict 一律是「样本不足」，不许给可用性结论", () => {
    for (let di = 0; di < 2; di++) {
      for (let c = 0; c < 4; c++) seedObs(di * 6, CODES[c], c + 1, (c + 1) * 2);
    }
    const r = evalFactorIc(db, F, "stock");
    expect(r.nObs).toBe(8);
    expect(r.nObs).toBeLessThan(MIN_OBS);
    expect(r.verdict).toBe("样本不足");
  });

  it("样本够且 IC 稳为正时判「显著」：IC 均值、IR、t 都要能算出来", () => {
    // 8 个日期 × 4 只票 = 32 条；偶数日完全同序，奇数日最后两名对调 → IC 在 1 与 0.8 之间摆
    for (let di = 0; di < 8; di++) {
      for (let c = 0; c < 4; c++) {
        const rets = [2, 4, 6, 8];
        const r = di % 2 === 1 && c >= 2 ? rets[5 - c] : rets[c];
        seedObs(di * 6, CODES[c], c + 1, r);
      }
    }
    const res = evalFactorIc(db, F, "stock");
    expect(res.nObs).toBe(32);
    expect(res.nCross).toBe(8);
    expect(res.icMean).toBeCloseTo(0.9, 6);
    expect(res.icStd).toBeGreaterThan(0);
    expect(res.ir).toBeGreaterThan(0.5);
    expect(res.tStat).toBeGreaterThan(2);
    expect(res.verdict).toBe("显著");
  });
});

describe("ledger/factor-eval 分组检验", () => {
  it("分组键是组内归一化后的秩，不是全局分位 —— 否则量到的又成了「那天怎样」", () => {
    // 两个日期的因子值整体差一个量级：全局分位会把第二天整批塞进最高组
    for (let c = 0; c < 4; c++) seedObs(0, CODES[c], c + 1, (c + 1) * 2);
    for (let c = 0; c < 4; c++) seedObs(6, CODES[c], 100 + c, (c + 1) * 2);
    const q = evalFactorQuantiles(db, F, "stock", { groups: 4 });
    // 按组内秩分 → 每天各自贡献 1 条到每一组，而不是第二天独占高组
    for (const g of q.groups) expect(g.n).toBe(2);
    expect(q.monotonicity).toBeCloseTo(1, 9);
  });

  it("多头那一段（最高一组）的超额要单独报 —— 只有它能兑现", () => {
    for (let di = 0; di < 8; di++) {
      for (let c = 0; c < 4; c++) seedObs(di * 6, CODES[c], c + 1, (c + 1) * 2);
    }
    const q = evalFactorQuantiles(db, F, "stock", { groups: 4 });
    expect(q.headMeanPct).toBeCloseTo(8, 6);
    expect(q.baseMeanPct).toBeCloseTo(5, 6);
    expect(q.headEdgePct).toBeCloseTo(3, 6);
    expect(q.monotonicity).toBeCloseTo(1, 9);
  });

  it("IC 为正但头部失效时，headEdge 必须把它暴露出来", () => {
    /**
     * 10 只票、分 5 组（每组 2 只）。收益设计成：低分组只是"小亏"，中间组吃到主升浪，
     * 最高组（v9/v10，多头真正会按它挑出来买的那两只）几乎没涨。
     *
     * 秩相关照样很强（≈0.81）—— 因为它主要由"低分组确实差"贡献；
     * 但能兑现的头部一段是负超额。只看 IC 就会以为这因子能用。
     *
     * 注意：每组只有 1 只票时这个现象构造不出来（最高组就是单只票，正 IC 下必然偏高），
     * 现实里"头部失效"也确实要每组多只才看得出来。
     */
    const rets = [-5, -4, -3, -2, -1, 30, 31, 32, 1, 0];
    for (let di = 0; di < 4; di++) {
      for (let c = 0; c < 10; c++) seedObs(di * 6, CODES10[c], c + 1, rets[c]);
    }
    const ic = evalFactorIc(db, F, "stock");
    const q = evalFactorQuantiles(db, F, "stock", { groups: 5 });
    expect(ic.icMean).toBeGreaterThan(0.5);
    expect(q.headMeanPct).toBeCloseTo(0.5, 6);      // 最高组几乎没涨
    expect(q.headEdgePct).toBeLessThan(0);          // 相对全样本是负超额
    expect(q.groups[3].meanFwdPct).toBeGreaterThan(30); // 而真正的大肉在中间组
  });

  it("没有样本的组返回 NaN 而不是 0 —— 0 会被读成「这组收益为零」", () => {
    seedObs(0, CODES[0], 1, 2);
    seedObs(0, CODES[1], 2, 4);
    const q = evalFactorQuantiles(db, F, "stock", { groups: 4 });
    const empty = q.groups.filter((g) => g.n === 0);
    expect(empty.length).toBeGreaterThan(0);
    for (const g of empty) expect(Number.isNaN(g.meanFwdPct)).toBe(true);
  });
});

describe("ledger/factor-eval 样本与口径", () => {
  it("定性因子（value 为 NULL）不进评估，绝不硬转成 0", () => {
    seedObs(0, CODES[0], 1, 2, { factor: "洗盘vs派发", value: null });
    seedObs(0, CODES[1], 2, 4, { factor: "洗盘vs派发", value: null });
    seedObs(0, CODES[2], 3, 6, { factor: "洗盘vs派发", value: null });
    expect(loadFactorObs(db, "洗盘vs派发", "stock")).toEqual([]);
  });

  it("作废与复权脏数据被排除 —— 那两类行的价格不可信", () => {
    seedObs(0, CODES[0], 1, 2);
    seedObs(0, CODES[1], 2, 4, { verdict: "作废" });
    seedObs(0, CODES[2], 3, 6, { dirty: "涨跌幅超上限，疑似复权跳变" });
    const obs = loadFactorObs(db, F, "stock");
    expect(obs).toHaveLength(1);
    expect(obs[0].code).toBe(CODES[0]);
  });

  it("前瞻收益用账本同一套取价：基准日→horizon 末，且与成交与否无关", () => {
    // 未触发（买点没够到）的样本照样能评估 —— 因子问的是"这个读数能不能预言涨跌"，
    // 只评估成交样本会引入选择偏差
    seedObs(0, CODES[0], 1, 2, { verdict: "未触发" });
    const obs = loadFactorObs(db, F, "stock");
    expect(obs).toHaveLength(1);
    expect(obs[0].fwdPct).toBeCloseTo(2, 6);
  });

  it("环境因子一天一个值，横截面秩相关无定义 → 走时间序列", () => {
    // 每天 3 只票，环境读数越高当天整体收益越高
    const envByDay = [1, 2, 3, 4];
    for (let di = 0; di < 4; di++) {
      for (let c = 0; c < 3; c++) {
        seedObs(di * 6, CODES[c], envByDay[di], envByDay[di] * 2 + c * 0.1,
          { factor: "情绪温度", scope: "env" });
      }
    }
    // 横截面视角：同日环境值全并列 → 一个截面都算不出来
    expect(crossSectionIc(loadFactorObs(db, "情绪温度", "env")).ics).toEqual([]);
    // 时间序列视角：4 个点，环境读数与当日平均收益完全同序
    const { ics } = envTimeSeriesIc(loadFactorObs(db, "情绪温度", "env"));
    expect(ics).toHaveLength(1);
    expect(ics[0]).toBeCloseTo(1, 9);
  });

  it("取不到基准价或 horizon 末价的观测整条丢弃，不猜价", () => {
    seedObs(0, CODES[0], 1, 2);
    // 这只票没有 horizon 末的日线
    seedDaily(db, CODES[1], [{ date: days[0], c: 10 }]);
    const id = `${days[0]}:s1:${CODES[1]}:买入`;
    insertPredRow(db, mkPred({
      id, ts: `${days[0]}T15:30:00+08:00`, phase: "盘后", code: CODES[1],
      evalHorizon: H, validUntil: days[H], triggerPx: null, stopPx: null,
    }));
    db.prepare(
      `INSERT OR REPLACE INTO prediction_factor
         (pred_id, factor_name, scope, version, value, label, confidence, created_at)
       VALUES (?, ?, 'stock', '1', 9, NULL, 1, ?)`
    ).run(id, F, `${days[0]}T15:30:00+08:00`);
    db.prepare(
      `INSERT OR REPLACE INTO outcome (pred_id, verdict, attribution, settled_at)
       VALUES (?, '命中', 't', ?)`
    ).run(id, `${days[H]}T15:30:00+08:00`);

    expect(loadFactorObs(db, F, "stock")).toHaveLength(1);
  });
});
