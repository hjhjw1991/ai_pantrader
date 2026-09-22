/**
 * 可配权重打分器 —— 第一个**真正替换掉 baseline 的槽实现**。
 *
 * 它存在的首要理由不是"更好"，是**证明槽位是插槽**：
 * 一个从没被替换过的接口，没有资格声称自己可插拔。在有第二份实现之前，
 * 所谓"5 槽引擎"和"把一个函数拆成五段"没有区别。
 *
 * 次要理由是兑现一条已经定下的设计：打分权重原先写死在 v1 的 buildCandidates 里
 * （0.30 连板 / 0.20 封单 / 0.20 均线 / 0.15 量能 / 0.15 龙虎榜），
 * 于是"这套重资金、那套重形态"这类对照根本表达不出来，只能改代码，
 * 改完还回不去，两代样本还会混进同一个分母。
 *
 * 筛与定价完全复用 baseline：本槽只换**排序依据**，不换"谁有资格进候选池"。
 * 这条边界是刻意的 —— 把筛也一起换掉的话，两套策略的候选池人口结构就不同了，
 * 影子盘比出来的胜负会分不清是"选得准"还是"筛得松"。
 */
import type {
  EvaluatedCandidate, EvaluatorSlot, PoolRow, SlotCtx, SlotParams,
} from "@/lib/contracts";
import { 评估器_七道筛打分 } from "@/lib/strategy/v2/slots/baseline";

/** 与 v1 写死的那组权重一致。不配参数时本槽的打分与 baseline 逐位相同 */
export interface 打分权重 {
  连板: number;
  封单: number;
  均线: number;
  量能: number;
  龙虎榜: number;
}

export const 默认权重: 打分权重 = {
  连板: 0.30,
  封单: 0.20,
  均线: 0.20,
  量能: 0.15,
  龙虎榜: 0.15,
};

/** 归一化上限，与 v1 一致：连板按 5 板封顶、封单按 3 亿封顶、量能按 2 倍封顶 */
const 连板封顶 = 5;
const 封单封顶 = 3e8;
const 量能封顶 = 2;

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);
const round6 = (x: number): number => Math.round(x * 1e6) / 1e6;

const numOf = (v: unknown, fallback: number): number =>
  typeof v === "number" && Number.isFinite(v) ? v : fallback;

function weightsFrom(params: SlotParams, warn: (m: string) => void): 打分权重 {
  const raw = params["权重"];
  if (raw === undefined) return 默认权重;
  if (raw === null || typeof raw !== "object") {
    warn(`打分权重配置无法解释（${JSON.stringify(raw)}），本轮回退到默认权重`);
    return 默认权重;
  }
  const o = raw as Record<string, unknown>;
  const w = {
    连板: numOf(o["连板"], 默认权重.连板),
    封单: numOf(o["封单"], 默认权重.封单),
    均线: numOf(o["均线"], 默认权重.均线),
    量能: numOf(o["量能"], 默认权重.量能),
    龙虎榜: numOf(o["龙虎榜"], 默认权重.龙虎榜),
  };
  /**
   * 不归一化，但和不为 1 时要说出来。
   *
   * 分数只用于**同一张卡内部**的排序与风控贪心分配，尺度本身不参与任何跨策略比较，
   * 所以硬归一化没必要。但权重和跑到 0.3 或 3.0 通常是配错了（漏写一项、小数点错位），
   * 而它的表现只是"排序看起来怪怪的"，不报出来就永远查不到。
   */
  const sum = w.连板 + w.封单 + w.均线 + w.量能 + w.龙虎榜;
  if (Math.abs(sum - 1) > 1e-6) {
    warn(`打分权重合计 ${round6(sum)} ≠ 1（不影响同卡内排序，但通常是配错了，请核对）`);
  }
  return w;
}

export const 评估器_可配权重打分: EvaluatorSlot = {
  kind: "评估器", name: "可配权重打分", version: "1.0.0",
  evaluate(
    ctx: SlotCtx, params: SlotParams, row: PoolRow, mainline: string
  ): EvaluatedCandidate | null {
    // 筛与定价一概走 baseline：本槽只换排序依据
    const base = 评估器_七道筛打分.evaluate(ctx, params, row, mainline);
    if (base === null) return null;

    const w = weightsFrom(params, ctx.warn);
    const valueOf = (name: string, fallback: number): number => {
      const f = base.factors.find(x => x.name === name);
      const v = f === undefined ? null : f.value;
      return typeof v === "number" && Number.isFinite(v) ? v : fallback;
    };

    const dir = valueOf("均线方向", 0);
    const vol = valueOf("量能", 1);
    const netAmt = valueOf("龙虎榜净买", 0);

    const score = round6(
      w.连板 * clamp01(row.lbc / 连板封顶) +
      w.封单 * clamp01(row.sealAmt / 封单封顶) +
      w.均线 * (dir > 0 ? 1 : 0) +
      w.量能 * clamp01(vol / 量能封顶) +
      w.龙虎榜 * (netAmt > 0 ? 1 : 0)
    );

    return { ...base, score };
  },
};
