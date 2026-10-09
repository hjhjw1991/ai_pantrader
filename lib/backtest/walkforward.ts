import type { BacktestMetrics, EquityPoint, WalkForwardWindow } from "@/lib/contracts";
import { computeMetricsDetailed, MIN_SAMPLE_DAYS } from "@/lib/backtest/metrics";
import type { ClosedTrade } from "@/lib/backtest/types";

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
  /**
   * 训练段的绝对天数。给了就**优先于 inSampleRatio**，测试段 = windowDays − trainDays。
   *
   * 为什么要有它：suggestAggregatedPlan 给的是"训练 252 / 测试 63、步长 63"，
   * 而 planWalkForward 只认比例，会把 315 天重新按 7:3 切成 221/94 ——
   * 测试段 94 天、步长 63 天，相邻样本外重叠 31 天，拼接时同一天被复利两次
   * （实测 1065 个交易日拼出 1116 天）。按天数传进来，测试段就等于步长，不再重叠。
   */
  trainDays?: number;
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
  const trainLen = o.trainDays !== undefined ? Math.round(o.trainDays) : Math.round(o.windowDays * ratio);
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

// ─────────────────────────────────────────────────────────────────────────────
// 参数稳定性
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 各窗口**自己**选出来的最优参数，是不是同一组。
 *
 * 这是过拟合最不容易伪装的一个指纹：
 *   - 真规律：哪段行情上去寻优，都挑到同一个山头（参数稳定）；
 *   - 拟合噪音：换一段行情就换一组参数（参数乱跳），
 *     因为上次那组只是那批数据的巧合，换个样本就失效。
 *
 * `bestParams` 早在每个窗口里都存下来了，但一直没人读 ——
 * 样本外 Calmar 达标而参数一路漂移，是最该警惕的一种"通过"。
 *
 * 两条判据（满足其一即判不稳）：
 *   - 取值太散：3 个以上不同取值，且没有任何取值占到一半以上；
 *   - 漂移太频：一半以上的窗口边界上参数都换了。
 */
export interface AxisStability {
  axis: string;
  /** 各窗口选出的取值，按窗口顺序 */
  values: unknown[];
  /** 取到过几个不同值 */
  distinct: number;
  /** 出现最多的那个值 */
  mode: unknown;
  /** 众数占窗口数的比例 */
  modeShare: number;
  /** 相邻窗口之间换了多少次 */
  switches: number;
  unstable: boolean;
}

export interface ParamStability {
  windows: number;
  axes: AxisStability[];
  unstableAxes: string[];
  /** 有任何一条轴不稳 */
  unstable: boolean;
  /** 窗口太少，不足以判断 */
  undecidable: boolean;
  note: string;
}

const r4 = (x: number): number => Math.round(x * 1e4) / 1e4;

/** 取值可能是 number/boolean/string/对象，比较一律走规范化 JSON，不靠 === */
function valueKey(v: unknown): string {
  return v === undefined ? "null" : JSON.stringify(v);
}

export function analyzeParamStability(windows: WalkForwardWindowList): ParamStability {
  const n = windows.length;
  if (n === 0) {
    return {
      windows: 0, axes: [], unstableAxes: [], unstable: false, undecidable: true,
      note: "没有 walk-forward 窗口，无从判断参数稳不稳",
    };
  }

  const axisNames = [...new Set(windows.flatMap((w) => Object.keys(w.bestParams)))];
  const axes: AxisStability[] = axisNames.map((axis) => {
    const values = windows.map((w) => w.bestParams[axis]);
    const keys = values.map(valueKey);

    const freq = new Map<string, { v: unknown; c: number }>();
    for (let i = 0; i < values.length; i++) {
      const hit = freq.get(keys[i]!);
      if (hit) hit.c += 1;
      else freq.set(keys[i]!, { v: values[i], c: 1 });
    }
    let mode: unknown = values[0];
    let modeCount = 0;
    for (const e of freq.values()) if (e.c > modeCount) { mode = e.v; modeCount = e.c; }

    let switches = 0;
    for (let i = 1; i < keys.length; i++) if (keys[i] !== keys[i - 1]) switches += 1;

    const distinct = freq.size;
    const modeShare = modeCount / n;
    // 两个窗口各挑一个值不算证据 —— 样本太小，判了也是掷骰子
    const unstable = n >= 3 && (
      (distinct >= 3 && modeShare < 0.5) || switches > (n - 1) / 2
    );
    return { axis, values, distinct, mode, modeShare: r4(modeShare), switches, unstable };
  });

  const unstableAxes = axes.filter((a) => a.unstable).map((a) => a.axis);
  /**
   * 一条轴都没有 = 每个窗口跑的都是同一套配置（根本没寻优）——
   * 此时"参数一致"是**本来如此**，不是验证过的结论。
   * 报成"稳定/真山头的样子"是最危险的一种假通过：它长得和真通过一模一样，
   * 而实际上什么都没测。窗口少于 3 个同理。
   */
  const undecidable = n < 3 || axes.length === 0;
  const note = axes.length === 0
    ? "没有寻优参数（各窗口跑的都是同一套配置），谈不上参数稳定性 —— 这是滚动样本外评估，不是完整 walk-forward"
    : undecidable
    ? `只有 ${n} 个窗口，不足以判断参数稳不稳（至少要 3 个）`
    : unstableAxes.length === 0
      ? `${n} 个窗口、${axes.length} 条轴：各窗口选出的参数一致，是真山头的样子`
      : `${n} 个窗口里，${unstableAxes.map((a) => {
        const s = axes.find((x) => x.axis === a)!;
        return `${a} 取了 ${s.distinct} 个不同值（众数只占 ${(s.modeShare * 100).toFixed(0)}%）`;
      }).join("；")} —— 换一段行情就换一组参数，是拟合噪音的样子；样本外成绩要打折看。`;

  return { windows: n, axes, unstableAxes, unstable: unstableAxes.length > 0, undecidable, note };
}

// ─────────────────────────────────────────────────────────────────────────────
// 聚合样本外（选项 D）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 单次 7:3 切分测不出结论的原因是分母：Calmar 的分母是最大回撤，
 * 而最大回撤是**极值统计量** —— 189 个交易日里通常只发生 1~2 段回撤，
 * 抽样误差极大且系统性偏小（期望最大回撤随 √时间 增长），
 * 于是 Calmar 被放大，放大倍数还不固定。这就是 MIN_SAMPLE_DAYS=252 的由来。
 *
 * spec R1 的有效区间约 630 个交易日，单次 7:3 只给 189 天样本外，必然退化；
 * 要样本外 ≥252 得总量 ≥840 天（3.3 年），数据没有。
 *
 * 解法不是放宽阈值，而是换切分方式：滚动多窗口，把各段**互不重叠**的样本外
 * 净值按链式收益拼成一条连续曲线，在这条曲线上算指标。
 * 630 天用 训练252/测试63/步长63 能切出 6 段，聚合样本外 378 天 > 252，非退化。
 *
 * 这不是取巧。每一段用的都是只看过该段之前数据训出的参数，
 * 拼出来的曲线正是"一个每季度重新调参的系统"真实会走出的净值 ——
 * 比单次切分更贴近实盘做法。这是 walk-forward 的标准用法。
 *
 * 代价写清楚：窗口数 × 寻优 = 数倍算力；每段训练期只有 1 年，拟合参数偏薄。
 */

/** 每段样本外都要给净值，不能只给指标 —— 只有净值才拼得起来 */
export interface SegmentResult {
  metrics: BacktestMetrics;
  equity: EquityPoint[];
  closed: ClosedTrade[];
}

export interface AggregatedRunOptions extends WalkForwardPlanOptions {
  optimize: (
    train: { from: string; to: string }, trainDays: string[]
  ) => { params: Record<string, unknown>; metrics?: BacktestMetrics };
  evaluate: (
    params: Record<string, unknown>, test: { from: string; to: string }, testDays: string[]
  ) => SegmentResult;
}

export interface AggregatedOos {
  /** 拼接后的连续样本外净值曲线 */
  equity: EquityPoint[];
  /** 在拼接曲线上算的指标 —— 这才是可用来判断的那个数 */
  metrics: BacktestMetrics;
  degeneracy: string[];
  /** 聚合后的样本外交易日数。判是否够 MIN_SAMPLE_DAYS 看这个 */
  oosDays: number;
  segments: number;
  /** 各段自己的 Calmar：聚合值好但段间方差极大，说明是某一段扛起来的 */
  segmentCalmars: number[];
  windows: WalkForwardWindowList;
}

/**
 * 链式拼接：每段净值先转成相对自身起点的收益，再复利叠到运行净值上。
 *
 * 为什么不直接把各段净值首尾相接：各段都从自己的基准（通常 1.0）起算，
 * 直接接会在段边界产生假跳空，最大回撤要么被凭空造出来要么被抹掉。
 */
export function stitchEquity(segments: EquityPoint[][]): EquityPoint[] {
  const out: EquityPoint[] = [];
  let running = 1;

  for (const seg of segments) {
    if (seg.length === 0) continue;
    const base = seg[0].equity;
    // 段起点净值为 0 或负：无法转成收益率，跳过并让上层在 degeneracy 里看到段数不符
    if (!Number.isFinite(base) || base <= 0) continue;

    for (let i = 1; i < seg.length; i++) {
      // 兜底：已经拼进曲线的日期不再计第二次。各段样本外本该互不重叠（见 planWalkForward 的 trainDays），
      // 但切法一旦配错（步长 < 测试段），重叠那几天的收益会被复利两次、曲线凭空变长 ——
      // 这里只认先到的那一段，后一段从它第一个新日期开始接
      const last = out.length > 0 ? out[out.length - 1].date : null;
      if (last !== null && seg[i].date <= last) continue;
      const prev = seg[i - 1].equity;
      const cur = seg[i].equity;
      if (!Number.isFinite(prev) || prev <= 0 || !Number.isFinite(cur)) continue;
      running *= cur / prev;
      out.push({ date: seg[i].date, equity: running, position: seg[i].position });
    }
    // 段内第一天没有前一日收益，用段起点占位，保证曲线不缺首日
    if (out.length === 0) {
      out.push({ date: seg[0].date, equity: running, position: seg[0].position });
    }
  }
  return out;
}

export function runWalkForwardAggregated(
  days: string[], o: AggregatedRunOptions
): AggregatedOos {
  const splits = planWalkForward(days, o);
  const windows: WalkForwardWindow[] = [];
  const segEquity: EquityPoint[][] = [];
  const closed: ClosedTrade[] = [];
  const segmentCalmars: number[] = [];

  for (const s of splits) {
    const best = o.optimize(s.train, s.trainDays);
    const seg = o.evaluate(best.params, s.test, s.testDays);
    windows.push(Object.freeze({
      train: Object.freeze({ ...s.train }),
      test: Object.freeze({ ...s.test }),
      bestParams: Object.freeze({ ...best.params }),
      testMetrics: Object.freeze({ ...seg.metrics }),
    }));
    segEquity.push(seg.equity);
    closed.push(...seg.closed);
    segmentCalmars.push(seg.metrics.calmar);
  }

  const equity = stitchEquity(segEquity);
  const detailed = computeMetricsDetailed({ equity, closed });

  return {
    equity,
    metrics: detailed.metrics,
    degeneracy: detailed.degeneracy,
    oosDays: equity.length,
    segments: splits.length,
    segmentCalmars,
    windows: Object.freeze(windows),
  };
}

/**
 * 给聚合结果的切分建议：在给定交易日数下，怎么切才能让聚合样本外过 252 天。
 * 返回 null = 这个区间无论怎么切都不够，该去解决数据（spec R1）而不是调参数。
 */
export function suggestAggregatedPlan(
  totalDays: number, o: { trainDays?: number; testDays?: number } = {}
): { windowDays: number; trainDays: number; testDays: number; stepDays: number; segments: number; oosDays: number } | null {
  const train = o.trainDays ?? MIN_SAMPLE_DAYS;      // 训练至少一年
  const test = o.testDays ?? Math.round(MIN_SAMPLE_DAYS / 4);   // 一季度
  const windowDays = train + test;
  if (totalDays < windowDays) return null;
  const segments = Math.floor((totalDays - train) / test);

  // 每段的第一天要当链式收益的基准用掉，拼接后每段只贡献 test-1 个点。
  // 必须按拼接后的真实长度算，否则这里承诺 378 天、实际曲线只有 372 天 ——
  // 差 6 天平时无害，但落在 252 阈值边缘就会"承诺够、实际退化"，
  // 而退化的表现是 Calmar 记 0，看起来像策略不行。
  const oosDays = segments * (test - 1);
  if (oosDays < MIN_SAMPLE_DAYS) return null;
  // trainDays/testDays 必须一起交给 planWalkForward：只给 windowDays 它会按 7:3 重切，
  // 测试段变成 94 天而步长还是 63 天，样本外互相重叠
  return { windowDays, trainDays: train, testDays: test, stepDays: test, segments, oosDays };
}

export interface AggregatedVerdict {
  pass: boolean;
  /** 拼接后仍退化（不足一年 / 笔数不足 / 零回撤）：测不出，判不过 */
  undecidable: boolean;
  calmar: number;
  oosDays: number;
  reasons: string[];
}

/**
 * 聚合样本外裁决：拼接曲线上的 Calmar 达标、且没被判退化才算过。
 * 和 walkForwardVerdict 同一条达标线，同样没有 override —— 不过就是不过。
 */
export function aggregatedVerdict(
  agg: Pick<AggregatedOos, "metrics" | "degeneracy" | "oosDays" | "segments">,
  o: Pick<VerdictOptions, "minCalmar"> = {}
): AggregatedVerdict {
  const minCalmar = o.minCalmar ?? 1;
  const calmar = agg.metrics.calmar;
  const reasons: string[] = [];
  const undecidable = agg.segments === 0 || agg.degeneracy.length > 0 || agg.oosDays < MIN_SAMPLE_DAYS;
  if (agg.segments === 0) reasons.push("没有任何聚合段：交易日不足，判不过（没测过 ≠ 通过）");
  if (agg.oosDays < MIN_SAMPLE_DAYS) reasons.push(`聚合样本外只有 ${agg.oosDays} 天 < ${MIN_SAMPLE_DAYS}，测不出结论`);
  if (agg.degeneracy.length > 0) reasons.push(`拼接曲线被判退化：${agg.degeneracy.join("；")}`);
  if (!undecidable && calmar < minCalmar) reasons.push(`聚合样本外 Calmar ${calmar.toFixed(2)} < ${minCalmar}`);
  return { pass: !undecidable && calmar >= minCalmar, undecidable, calmar, oosDays: agg.oosDays, reasons };
}

/**
 * 脚本退出码。给了 --aggregated 就**以聚合裁决为准**：
 * 那时单窗口样本外只有一个季度，必然退化、必然"不通过"，
 * 拿它当门槛等于永远红 —— 而聚合裁决不过时也必须红，不能只打印不拦。
 */
export function walkForwardExitCode(
  perWindow: { pass: boolean }, aggregated: { pass: boolean } | null
): 0 | 1 {
  if (aggregated !== null) return aggregated.pass ? 0 : 1;
  return perWindow.pass ? 0 : 1;
}
