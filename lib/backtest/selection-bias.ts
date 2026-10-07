import { stdev } from "@/lib/backtest/series";

/**
 * 选择偏差：试了 N 个参数组合之后，"最好的那个"天然被抬高多少。
 *
 * 这是整个防过拟合链条里唯一一处**没有**被盖住的洞：
 *   - 样本量不够 → metrics 判退化、Calmar 记 0（已有）
 *   - 参数峰太陡 → optimizer 报 sharpness/overfitRisk（已有）
 *   - 只看样本外 → walk-forward 的 7:3 切分（已有）
 *   - 试了 36 个组合取最好 → **以前没有任何数字去抵消这个抬高**
 *
 * 抬高有多大是可以算的：从同一个分布里抽 N 次取最大值，那个最大值的期望
 * 比均值高约 σ·sqrt(2·ln N)。N=36 时约 2.68σ —— 也就是说，
 * 哪怕 36 套参数**全都一样好**，光靠"挑最好的那个"也能挑出一个比均值高 2.68 个
 * 标准差的漂亮数字。这个数字不是策略的本事，是挑选动作送的。
 *
 * 所以它必须被减掉：不减，人看到的是"最优 Calmar 1.9"，
 * 而这个 1.9 里有 1.4 是运气。
 */

export interface SelectionBias {
  /** 试了多少个组合（N）。N=1 谈不上选择偏差 */
  trials: number;
  /** 全部评估点 Calmar 的均值 */
  mean: number;
  /** 全部评估点 Calmar 的样本标准差（n−1）。只有一点时为 0 */
  sd: number;
  /**
   * 运气天花板：什么都不做、纯靠挑，最好那个能到多少。
   * = mean + sd·sqrt(2·ln N)
   */
  chanceCeiling: number;
  /** 最优点扣掉运气额度后还剩多少。≤ 0 意味着成绩能被"试了很多次"解释掉 */
  deflated: number;
  /** deflated ≤ 0：成绩没有超过运气能给的高度 */
  overfitSuspected: boolean;
  /** 人话版本，直接给界面显示 */
  note: string;
}

/**
 * N 次抽样里最大值的期望（标准化后）≈ sqrt(2·ln N)。
 *
 * 为什么用主项而不用带修正项的完整渐近式
 * （sqrt(2 ln N) − (ln ln N + ln 4π) / (2·sqrt(2 ln N))，N=36 时约 1.97）：
 * 修正项让天花板**变低**，也就是更容易放行。两个方向里选保守的这个 ——
 * 放过一个真过拟合的参数，代价是拿它去下真金；误报一次，代价是多看两眼。
 *
 * 也不用正态分位数表的精确值：Calmar 根本不是正态（有下界、右偏、极值统计量的
 * 抽样误差极大），精确到小数点后两位的正态值只会给出一种虚假的确定感。
 * 这里要的是"这个量级"，不是"这个数"。
 */
export function expectedMaxSigma(trials: number): number {
  if (trials <= 1) return 0;
  return Math.sqrt(2 * Math.log(trials));
}

const r4 = (x: number): number => Math.round(x * 1e4) / 1e4;

/**
 * 浮点噪音归零。
 *
 * 36 个一模一样的成绩，样本标准差算出来是 3e-16 而不是 0，
 * 于是 deflated 是 −1.2e-15 —— 显示成 "-0.00"，而"扣掉运气后剩负零"
 * 这句话本身没有意义，还会让人以为判定在 0 附近抖。
 * 同一批数据多跑一次不该给出不同的读数，所以这个量级的残差一律归零。
 */
const EPS = 1e-12;
const clean = (x: number): number => (Math.abs(x) < EPS ? 0 : x);

/**
 * 从**全部评估点的成绩**算选择偏差。
 *
 * 传进来的必须是这次寻优真正评估过的每一个点（含由粗到精多出来的那些），
 * 而不是"网格有多少格" —— refine 每插一个中点就多给一次挑选机会，
 * 少算一次就少减一点运气。
 */
export function selectionBias(calmars: readonly number[]): SelectionBias {
  const xs = calmars.filter((c) => Number.isFinite(c));
  const trials = xs.length;

  if (trials === 0) {
    return {
      trials: 0, mean: 0, sd: 0, chanceCeiling: 0, deflated: 0,
      overfitSuspected: false,
      note: "没有任何评估点，谈不上选择偏差",
    };
  }

  const mean = xs.reduce((a, b) => a + b, 0) / trials;
  const sd = clean(stdev(xs) ?? 0);
  const best = Math.max(...xs);
  const chanceCeiling = mean + sd * expectedMaxSigma(trials);
  const deflated = clean(best - chanceCeiling);
  const overfitSuspected = deflated <= 0;

  const note = trials === 1
    ? "只试了 1 个组合，无选择偏差可减"
    : `试了 ${trials} 个组合：均值 ${mean.toFixed(2)}、标准差 ${sd.toFixed(2)}，` +
      `光靠挑最好那个就能挑到 ${chanceCeiling.toFixed(2)}；` +
      `最优点 ${best.toFixed(2)} 扣掉这份运气后剩 ${r4(deflated).toFixed(2)}` +
      ` —— ${overfitSuspected ? "这个成绩基本能被「试了很多次」解释掉" : "超出运气能给的高度"}。`;

  return {
    trials,
    mean: r4(mean),
    sd: r4(sd),
    chanceCeiling: r4(chanceCeiling),
    deflated: r4(deflated),
    overfitSuspected,
    note,
  };
}
