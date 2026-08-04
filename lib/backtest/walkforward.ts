import type { BacktestMetrics, WalkForwardWindow } from "@/lib/contracts";

/**
 * walk-forward 滚动验证（spec §10.4）。
 *
 * 不可谈判的一条：**样本外不过就是不过，不许回头调样本内。**
 * 这条纪律靠三件事在代码层面兜住，而不是靠人自觉：
 *
 *   1. optimize 的签名只收训练区间。它连测试区间的日期都拿不到，
 *      想"顺手看一眼样本外"都没有入口；
 *   2. 每个窗口的 evaluate 只调用一次，产出立刻 Object.freeze，事后改不动；
 *   3. 本模块不导出任何 retune/refit 类 API，导出面在测试里是白名单。
 *
 * 想改参数？那就是一个新策略版本，重新走全流程，而不是在旧结论上修修补补。
 */

/** 样本内/外 7:3（spec §10.4）。允许覆盖，但必须显式写出来 */
export const IN_SAMPLE_RATIO = 0.7;

export interface WalkForwardPlanOptions {
  /** 单个窗口的总交易日数（训练 + 测试） */
  windowDays: number;
  /** 滚动步长，默认 = 测试段长度，使各窗口的样本外区间互不重叠 */
  stepDays?: number;
  inSampleRatio?: number;
}

export interface WalkForwardSplit {
  train: { from: string; to: string };
  test: { from: string; to: string };
  trainDays: string[];
  testDays: string[];
}

export interface WalkForwardRunOptions extends WalkForwardPlanOptions {
  /**
   * 样本内寻优。**只拿到训练区间** —— 这个签名就是"不许回头调样本内"的保证。
   * 别在实现里通过闭包偷偷访问测试数据：那等于自己作弊，代码拦不住，但纪律拦得住。
   */
  optimize: (
    train: { from: string; to: string }, trainDays: string[]
  ) => { params: Record<string, unknown>; metrics?: BacktestMetrics };
  /** 样本外评估。每个窗口只调一次，结果即终局 */
  evaluate: (
    params: Record<string, unknown>, test: { from: string; to: string }, testDays: string[]
  ) => BacktestMetrics;
}

/** 只读的窗口列表：连 push 都不允许，防止"补一个好窗口"这种操作 */
export type WalkForwardWindowList = readonly WalkForwardWindow[];

export function planWalkForward(days: string[], o: WalkForwardPlanOptions): WalkForwardSplit[] {
  const ratio = o.inSampleRatio ?? IN_SAMPLE_RATIO;
  // 用 round 不用 floor：360*0.7 在浮点里是 251.99999999999997，floor 会切出 251/109，
  // 7:3 就悄悄歪了。切分比例这种"人说得出口的数"不该被浮点误差改写
  const trainLen = Math.round(o.windowDays * ratio);
  const testLen = o.windowDays - trainLen;
  const step = o.stepDays ?? testLen;
  if (trainLen <= 0 || testLen <= 0 || step <= 0) return [];
  // 凑不满一个完整窗口就不做 —— 半个窗口的样本外结论没有意义
  if (days.length < o.windowDays) return [];

  const out: WalkForwardSplit[] = [];
  for (let start = 0; start + o.windowDays <= days.length; start += step) {
    const trainDays = days.slice(start, start + trainLen);
    const testDays = days.slice(start + trainLen, start + o.windowDays);
    out.push({
      train: { from: trainDays[0], to: trainDays[trainDays.length - 1] },
      test: { from: testDays[0], to: testDays[testDays.length - 1] },
      trainDays, testDays,
    });
  }
  return out;
}

export function runWalkForward(days: string[], o: WalkForwardRunOptions): WalkForwardWindowList {
  const splits = planWalkForward(days, o);
  const windows: WalkForwardWindow[] = [];
  for (const s of splits) {
    const best = o.optimize(s.train, s.trainDays);
    const testMetrics = o.evaluate(best.params, s.test, s.testDays);
    windows.push(Object.freeze({
      train: Object.freeze({ ...s.train }),
      test: Object.freeze({ ...s.test }),
      bestParams: Object.freeze({ ...best.params }),
      // 冻结样本外指标：产出之后谁都改不了，包括后来的自己
      testMetrics: Object.freeze({ ...testMetrics }),
    }));
  }
  return Object.freeze(windows);
}

export interface WalkForwardVerdict {
  pass: boolean;
  windows: number;
  medianOosCalmar: number;
  /** 达标窗口占比 */
  passRatio: number;
  failedWindows: Array<{ test: { from: string; to: string }; calmar: number }>;
  /**
   * true = 根本没测出来（没有窗口，或所有样本外 Calmar 都被退化规则记成 0），
   * 区别于"测出来了但不达标"。两者 pass 都是 false —— 测不出不能算通过 ——
   * 但归因完全不同：前者要加长样本外区间，后者要换策略。
   */
  undecidable: boolean;
  reasons: string[];
}

export interface VerdictOptions {
  /** 单窗口样本外 Calmar 达标线 */
  minCalmar?: number;
  /** 达标窗口占比下限 */
  minPassRatio?: number;
}

/**
 * 样本外裁决。没有 override 参数 —— 不过就是不过。
 * 窗口数为 0 时判不过：没测过不等于通过，这是最常见的自欺路径。
 */
export function walkForwardVerdict(
  windows: WalkForwardWindowList, o: VerdictOptions = {}
): WalkForwardVerdict {
  const minCalmar = o.minCalmar ?? 1;
  const minPassRatio = o.minPassRatio ?? 0.6;
  const reasons: string[] = [];

  if (windows.length === 0) {
    return {
      pass: false, windows: 0, medianOosCalmar: 0, passRatio: 0, failedWindows: [],
      undecidable: true,
      reasons: ["没有任何 walk-forward 窗口：交易日不足或区间过短，判不过（没测过 ≠ 通过）"],
    };
  }

  const calmars = windows.map((w) => w.testMetrics.calmar);
  const sorted = [...calmars].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const medianOosCalmar = sorted.length % 2 === 1
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;

  const failedWindows = windows
    .filter((w) => w.testMetrics.calmar < minCalmar)
    .map((w) => ({ test: { ...w.test }, calmar: w.testMetrics.calmar }));
  const passRatio = (windows.length - failedWindows.length) / windows.length;

  if (failedWindows.length > 0) {
    reasons.push(
      `${failedWindows.length}/${windows.length} 个窗口样本外 Calmar < ${minCalmar}：` +
      failedWindows.map((f) => `${f.test.from}~${f.test.to} (${f.calmar.toFixed(2)})`).join("、")
    );
  }
  if (passRatio < minPassRatio) {
    reasons.push(`样本外达标率 ${(passRatio * 100).toFixed(0)}% < ${(minPassRatio * 100).toFixed(0)}%，不通过`);
  }
  if (medianOosCalmar < minCalmar) {
    reasons.push(`样本外 Calmar 中位数 ${medianOosCalmar.toFixed(2)} < ${minCalmar}`);
  }

  // 全 0 = metrics 把每个窗口都判了退化（样本外区间不足一年 / 笔数不足 / 零回撤）。
  // 这时候说"策略不行"是错的归因，真相是"这个切分测不出东西"。
  // 注意 Calmar 要非退化，样本外段本身就得 ≥252 交易日 —— 7:3 意味着单窗口要 ≥840 个交易日，
  // 而 spec R1 的有效区间只有约 2.6 年（≈630 日）。这个张力是数据决定的，不是代码能绕的。
  const undecidable = calmars.every((c) => c === 0);
  if (undecidable) {
    reasons.push(
      "所有窗口的样本外 Calmar 都是 0（被 metrics 判退化）：样本外区间太短或往返笔数太少，" +
      "本次 walk-forward 测不出结论 —— 判不过，但归因是区间不足，不是策略不行。"
    );
  }

  return {
    pass: !undecidable && passRatio >= minPassRatio && medianOosCalmar >= minCalmar,
    windows: windows.length, medianOosCalmar, passRatio, failedWindows, undecidable, reasons,
  };
}

export interface WalkForwardSummary {
  meanInSampleCalmar: number;
  meanOutOfSampleCalmar: number;
  /** 样本外/样本内。远小于 1 = 参数是拟合出来的，不是规律 */
  decayRatio: number;
  overfitSuspected: boolean;
}

/**
 * 样本内外落差。样本内 3.0、样本外 0.2 这种落差不是"运气差"，是过拟合的标准长相。
 * 阈值 0.5：样本外掉到样本内一半以下就点名，不给"再调调看"的余地。
 */
export function summarizeWalkForward(
  windows: WalkForwardWindowList, inSampleMetrics: BacktestMetrics[]
): WalkForwardSummary {
  const mean = (xs: number[]) => (xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length);
  const isMean = mean(inSampleMetrics.map((m) => m.calmar));
  const oosMean = mean(windows.map((w) => w.testMetrics.calmar));
  const decayRatio = isMean === 0 ? 0 : oosMean / isMean;
  return {
    meanInSampleCalmar: isMean,
    meanOutOfSampleCalmar: oosMean,
    decayRatio,
    overfitSuspected: isMean > 0 && decayRatio < 0.5,
  };
}
