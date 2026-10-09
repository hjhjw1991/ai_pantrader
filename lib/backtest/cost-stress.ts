/**
 * 成本压力测试：把滑点与费用按倍数往上加，看策略在第几倍上不再赚钱。
 *
 * 为什么要有这个东西 —— 数字先摆出来（库里唯一一份有 126 笔的真回测）：
 *   全年成交额是本金的 30 倍，成本占本金 6.19%，而净收益只有 7.38%，
 *   毛收益 13.57%。也就是说**成本吃掉了将近一半的毛收益**。
 * 在这种情况下，"滑点翻倍还赚不赚钱"不是学术问题，是这个策略成不成立的问题。
 * 而在此之前，滑点与费率是写死的常量（DEFAULT_CONSTRAINTS），没有任何入口能问这句话。
 *
 * **为什么必须重跑，不能解析外推。**
 * 最省事的做法是：跑一次，拿到成交额，然后按"成本 × 倍数"从收益里减掉。
 * 那样算出来的曲线是错的，而且错得很像对的 ——
 * 因为滑点不只是从收益里扣一笔钱，它改变成交价，成交价改变净值，
 * 净值改变下一笔的仓位与手数取整，手数取整又决定这笔能不能成交。
 * 路径整个变了。所以每一个成本档位都是一次完整回测，一次都不能省。
 *
 * 判据用**总收益**而不是 Calmar：Calmar 在样本不足时会被 metrics 判退化记 0
 * （见 metrics.ts 的 MIN_SAMPLE_*），"记 0"和"真的不赚钱"在数字上无法区分，
 * 拿它判盈亏会把"样本不够"读成"策略不行"。
 */
import type { BacktestMetrics, Constraints, EquityPoint } from "@/lib/contracts";
import { MIN_SAMPLE_DAYS, MIN_SAMPLE_TRADES } from "@/lib/backtest/metrics";

/** 归零倍数低于这个值 = 极脆弱：成本涨一半就死 */
export const VERY_FRAGILE_AT = 1.5;
/** 归零倍数低于这个值 = 脆弱 */
export const FRAGILE_AT = 2.5;
/**
 * 说"扛得住"之前，至少得测到这个倍数还没归零。
 * 只测到 1.5 倍就说稳健，是把"没测到边界"说成了"边界很远" —— 方向错了。
 */
export const ROBUST_NEEDS = 2.5;

export interface CostLevel {
  /** 相对现行成本假设的倍数。0 = 零摩擦（这套策略的收益上限） */
  multiplier: number;
  slippage: number;
  feeRate: number;
  minFee: number;
}

/** 一次回测的产出。只要判盈亏用的那几个量，不把整份报告拖进来 */
export interface StressOutcome {
  metrics: BacktestMetrics;
  equity: EquityPoint[];
}

export interface CostStressPoint {
  level: CostLevel;
  /** 期末/期初 − 1。判盈亏看这个，不看 Calmar */
  totalReturn: number;
  annualReturn: number;
  calmar: number;
  profitFactor: number;
  trades: number;
  /** 这一档的指标是不是被判退化（样本不足）—— 退化档的数字不能当结论用 */
  degenerated: boolean;
}

export type CostVerdict =
  /** 现行成本下就不赚钱 */
  | "unprofitable"
  /** 归零倍数 < 1.5 */
  | "veryFragile"
  /** 归零倍数 < 2.5，或压根没测到边界 */
  | "fragile"
  /** 到 2.5 倍（且最高档 ≥ 2.5）还没归零 */
  | "robust"
  /** 档位不够，无从判断 */
  | "undecidable";

export interface CostStressResult {
  /** 按倍数升序 */
  points: CostStressPoint[];
  /** 现行成本那一档（倍数 1）。没跑这一档就是 null */
  baseline: CostStressPoint | null;
  /** 零摩擦那一档（倍数 0），用来看上限与"成本吃掉了多少" */
  frictionless: CostStressPoint | null;
  /**
   * 净收益归零时的成本倍数，在已测档位之间线性插值。
   * null = 已测档位内没归零；**不外推**，边界在更高处而本次没测到就是没测到。
   */
  breakevenMultiplier: number | null;
  /** 所有档都还赚钱。true 时必须配 note 说明没测到边界 */
  neverBreaks: boolean;
  /** 成本吃掉了零摩擦收益的多大比例。近似值，见下方注释 */
  costShare: number | null;
  verdict: CostVerdict;
  note: string;
}

/** 按倍数缩放成本。0 倍 = 零摩擦，是一个有意义的档位（策略上限），不是非法输入 */
export function scaleConstraints(base: Constraints, multiplier: number): Constraints {
  return {
    ...base,
    slippage: base.slippage * multiplier,
    feeRate: base.feeRate * multiplier,
    minFee: base.minFee * multiplier,
  };
}

export function levelOf(base: Constraints, multiplier: number): CostLevel {
  const c = scaleConstraints(base, multiplier);
  return { multiplier, slippage: c.slippage, feeRate: c.feeRate, minFee: c.minFee };
}

const r4 = (x: number): number => Math.round(x * 1e4) / 1e4;

/**
 * 把一次回测的结果折成一个档位点。
 *
 * 单独导出是因为长跑要能**断点续跑**：一次回测十几分钟，跑几档之后进程崩了
 * （实测：3.78GB 的库上连跑多档会撞上 SQLite 的 disk I/O error），
 * 已经跑出来的那几档不能白跑。于是档位点（纯数值，几字节）可以落盘，
 * 下次启动补齐缺档再统一判定 —— 判定与"跑"这两件事必须能分开。
 */
export function toStressPoint(level: CostLevel, o: StressOutcome): CostStressPoint {
  const eq = o.equity;
  const first = eq.length > 0 ? eq[0].equity : 0;
  const last = eq.length > 0 ? eq[eq.length - 1].equity : 0;
  // 空曲线不冒充 0 收益：那是"没跑出来"，不是"不赚不赔"
  const totalReturn = eq.length === 0 || first <= 0 ? 0 : last / first - 1;
  const degenerated =
    o.metrics.calmar === 0 ||
    o.metrics.trades < MIN_SAMPLE_TRADES ||
    eq.length < MIN_SAMPLE_DAYS;
  return {
    level,
    totalReturn: r4(totalReturn),
    annualReturn: r4(o.metrics.annualReturn),
    calmar: r4(o.metrics.calmar),
    profitFactor: r4(o.metrics.profitFactor),
    trades: o.metrics.trades,
    degenerated,
  };
}

/**
 * 找净收益归零的倍数。
 *
 * 只插值，不外推：曲线在两档之间是什么形状没人知道，
 * 而"猜一个比测过的最高档还大的数"正是这类工具最容易骗人的地方 ——
 * 它给出的数看着精确，实际是编的。
 */
function breakeven(pts: CostStressPoint[]): { at: number | null; neverBreaks: boolean } {
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i], b = pts[i + 1];
    if (a.totalReturn > 0 && b.totalReturn <= 0) {
      // 线性插值：从 a 的正收益降到 b 的非正收益，零点在哪
      const t = a.totalReturn / (a.totalReturn - b.totalReturn);
      const at = a.level.multiplier + (b.level.multiplier - a.level.multiplier) * t;
      return { at: r4(at), neverBreaks: false };
    }
  }
  // 一档都没跨过 0。若第一档就已经 ≤ 0，那是"零摩擦就不赚"，不是"没测到边界"。
  // 只有一档时不许说"从不归零" —— 那等于把"没测过加压"说成"测过还活着"，
  // 只有一档时的正确说法是 undecidable
  const neverBreaks = pts.length >= 2 && pts[0].totalReturn > 0;
  return { at: null, neverBreaks };
}

/**
 * 只做判定，不跑回测。档位点可以从磁盘上读回来（见 toStressPoint 的说明）。
 * @param points 可以乱序、可以不全；不全时判据会如实退回 undecidable/脆弱
 */
export function evaluateCostStress(points: CostStressPoint[]): Omit<CostStressResult, "points"> & { points: CostStressPoint[] } {
  const pts = [...points]
    .filter((p) => Number.isFinite(p.level.multiplier) && p.level.multiplier >= 0)
    .sort((a, b) => a.level.multiplier - b.level.multiplier);

  const baseline = pts.find((p) => p.level.multiplier === 1) ?? null;
  // 下面一律用排好序的 pts，不能碰入参 points：续跑时新档追加在旧档之后，
  // 入参的顺序是乱的，拿它找归零点、取最高档会判错（曾把全盈利判成脆弱）
  const frictionless = pts.find((p) => p.level.multiplier === 0) ?? null;
  const { at, neverBreaks } = breakeven(pts);
  const maxM = pts.length > 0 ? pts[pts.length - 1].level.multiplier : 0;

  /**
   * 成本吃掉的比例 = 1 − 现行净收益 / 零摩擦收益。
   * 这是**近似**：零摩擦那档走的是另一条路径（成交价不同 → 净值不同 → 仓位不同），
   * 所以两者的差不完全等于"成本"，里面还夹着路径差。当它说"成本吃掉一半"时，
   * 要读成"量级是一半"，不是"精确 46.2%"。
   */
  const costShare =
    frictionless !== null && baseline !== null && frictionless.totalReturn > 0
      ? r4(1 - baseline.totalReturn / frictionless.totalReturn)
      : null;

  const degeneratedLevels = pts.filter((p) => p.degenerated).map((p) => p.level.multiplier);

  const notes: string[] = [];
  let verdict: CostVerdict;

  if (pts.length < 2) {
    verdict = "undecidable";
    notes.push(`只有 ${pts.length} 个成本档位，判不出归零点 —— 至少要两档，其中含现行成本那一档`);
  } else if (frictionless !== null && frictionless.totalReturn <= 0) {
    // 零摩擦都不赚钱：这时候说"成本压垮了策略"是甩锅，问题在策略本身
    verdict = "unprofitable";
    notes.push(
      `零摩擦档（成本 ×0）净收益 ${(frictionless.totalReturn * 100).toFixed(2)}% —— ` +
      `连手续费滑点都没有都不赚钱，这不是成本问题，是策略本身不赚钱`
    );
  } else if (baseline === null) {
    verdict = "undecidable";
    notes.push("没有跑现行成本那一档（×1），无从判断「现行假设下赚不赚钱」");
  } else if (baseline.totalReturn <= 0) {
    verdict = "unprofitable";
    notes.push(
      `现行成本下净收益 ${(baseline.totalReturn * 100).toFixed(2)}% —— 按当前滑点与费率假设就已经不赚钱，` +
      `再谈"成本涨了会不会死"没有意义`
    );
  } else if (at !== null && at < VERY_FRAGILE_AT) {
    verdict = "veryFragile";
    notes.push(
      `成本涨到 ${at.toFixed(2)} 倍（现行 ×${at.toFixed(2)}）净收益就归零 —— ` +
      `脆弱到这个程度，等于把策略的生死交给一个没人验证过的成本假设`
    );
  } else if (at !== null && at < FRAGILE_AT) {
    verdict = "fragile";
    notes.push(`成本涨到 ${at.toFixed(2)} 倍净收益归零 —— 真实滑点只要比假设差一半，收益就所剩无几`);
  } else if (at === null && maxM < ROBUST_NEEDS) {
    // 没测到边界，但也没测多远 —— 保守判脆弱，不说稳健
    verdict = "fragile";
    notes.push(
      `已测最高 ×${maxM} 仍未归零，但没测到 ×${ROBUST_NEEDS} 以上 —— ` +
      `**没测到边界不等于边界很远**，不敢判稳健。想判就把档位加到 ×3 或更高`
    );
  } else if (at === null) {
    verdict = "robust";
    notes.push(`到 ×${maxM} 仍未归零，且已测过 ×${ROBUST_NEEDS} —— 在这个范围内成本不是致命项`);
  } else {
    verdict = "robust";
    notes.push(`成本涨到 ${at.toFixed(2)} 倍才归零，余量足够`);
  }

  if (costShare !== null && frictionless !== null && baseline !== null) {
    notes.push(
      `成本吃掉了零摩擦收益的 ${(costShare * 100).toFixed(1)}%` +
      `（零摩擦 ${(frictionless.totalReturn * 100).toFixed(2)}% → 现行 ${(baseline.totalReturn * 100).toFixed(2)}%，含路径差，是量级不是精确值）`
    );
  }
  if (degeneratedLevels.length > 0) {
    notes.push(
      `×${degeneratedLevels.join("、×")} 档指标被判退化（笔数 < ${MIN_SAMPLE_TRADES} 或区间 < ${MIN_SAMPLE_DAYS} 天），` +
      `这几档的数字只作参考，Calmar 已按规矩记 0`
    );
  }

  return {
    points: pts, baseline, frictionless,
    breakevenMultiplier: at, neverBreaks, costShare,
    verdict, note: notes.join("；"),
  };
}

/**
 * 跑完并判定。档位数 × 一次回测的耗时 = 总耗时，一档十几分钟的那种回测
 * 请用 toStressPoint + evaluateCostStress 落盘续跑，别指望一次跑完。
 *
 * @param run 跑一个成本档位。每档一次完整回测（见文件头：不能外推）
 * @param multipliers 成本倍数。建议含 0（上限）与 1（现行），以及 1.5 / 2 / 3 这几个加压档
 */
export function costStress(
  base: Constraints,
  run: (level: CostLevel) => StressOutcome,
  multipliers: number[],
): CostStressResult {
  const seen = new Set<number>();
  const uniq = multipliers.filter((m) => {
    if (!Number.isFinite(m) || m < 0 || seen.has(m)) return false;
    seen.add(m);
    return true;
  });

  const points = uniq
    .sort((a, b) => a - b)
    // 同一个 level 对象既记进结果也交给 run：否则"记录的成本档"与"实际跑的成本档"
    // 可能是两个值，而这两个值不一致时没有任何地方会报错
    .map((m) => {
      const lv = levelOf(base, m);
      return toStressPoint(lv, run(lv));
    });

  return evaluateCostStress(points);
}
