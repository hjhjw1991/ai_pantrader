/**
 * 结构位定价评估器：在 baseline 筛完的候选上补**目标位与盈亏比**，并按盈亏比取舍、排序。
 *
 * 这是"主要看盈亏比"那条交易理念的第一份实现。与可配权重打分同一条边界：
 * 筛与触发价 / 止损价完全复用 baseline，本槽只加目标位、换排序依据、多一道盈亏比门槛。
 * 筛也一起换的话，影子盘里两套策略的候选池人口结构就不同了，
 * 胜负分不清是"定价准"还是"筛得松"。
 *
 * 目标位：
 *   - 优先取前高（结构位因子的阻力）—— 真实的套牢盘所在
 *   - 前高 ≤ 触发价（到价买入的那一刻它已被突破）或上方无前高（创新高）时，
 *     用 触发价 + N × ATR 兜底。已被突破的前高不再是阻力，拿它当目标会把盈亏比算成负数
 *
 * 价格全是原始价口径（结构位与 ATR 因子已从后复权换回）：目标位要挂进券商。
 */
import type {
  EvaluatedCandidate, EvaluatorSlot, FactorResult, PoolRow, SlotCtx, SlotParams,
} from "@/lib/contracts";
import { 评估器_七道筛打分 } from "@/lib/strategy/v2/slots/baseline";

const round2 = (x: number): number => Math.round(x * 100) / 100;
const round6 = (x: number): number => Math.round(x * 1e6) / 1e6;
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

export const 评估器_结构位定价: EvaluatorSlot = {
  kind: "评估器", name: "结构位定价", version: "1.0.0",
  evaluate(
    ctx: SlotCtx, params: SlotParams, row: PoolRow, mainline: string
  ): EvaluatedCandidate | null {
    const base = 评估器_七道筛打分.evaluate(ctx, params, row, mainline);
    if (base === null) return null;

    const minRr = num(params["最低盈亏比"]) ?? 1.5;
    const atrK = num(params["ATR目标倍数"]) ?? 3;

    const struct = ctx.runFactor("结构位", { code: row.code });
    const atrF = ctx.runFactor("ATR", { code: row.code });
    const extra: FactorResult<any>[] = [struct, atrF].filter((f): f is FactorResult<any> => f !== null);

    const trig = base.triggerPx;
    const res = num(struct?.inputs?.["阻力"]);
    const atr = num(atrF?.inputs?.["ATR"]);

    let target: number | null = null, source = "";
    // 前高是后复权价除回来的，带浮点尾巴（8.030673）。券商只收到分的价格，挂单前必须取整
    if (res !== null && round2(res) > trig) {
      target = round2(res); source = "前高";
    } else if (atr !== null && atr > 0) {
      target = round2(trig + atrK * atr);
      source = res === null ? `上方无前高，ATR×${atrK}` : `前高 ${res} 已在触发价下方，ATR×${atrK}`;
    }
    if (target === null) {
      ctx.warn(`结构位定价：${row.code} 算不出目标位（无结构位也无 ATR），不进候选`);
      return null;
    }

    const stop = base.stopPx;
    const rr = stop !== null && trig > stop ? round6((target - trig) / (trig - stop)) : null;
    if (rr === null) {
      ctx.warn(`结构位定价：${row.code} 所在账户（${base.account}）没有止损价，盈亏比无法判定，按最低优先级保留`);
    } else if (rr < minRr) {
      ctx.warn(`结构位定价：${row.code} 盈亏比 ${rr.toFixed(2)} < 门槛 ${minRr}，不进候选`);
      return null;
    }

    return {
      ...base,
      targetPx: target,
      rrRatio: rr,
      thesis: `${base.thesis}；目标 ${target}（${source}），盈亏比 ${rr === null ? "—（无止损价）" : rr.toFixed(2)}`,
      factors: [...base.factors, ...extra],
      // 本槽的排序依据就是盈亏比。算不出盈亏比的排最后，但不剔除 —— 无止损价是账户配置问题，不是票的问题
      score: rr ?? -1,
    };
  },
};
