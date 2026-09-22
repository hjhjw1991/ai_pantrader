/**
 * v2 引擎的槽位契约。
 *
 * v1 的引擎是一条直线：择时 → 主线 → 三路候选 → 七道筛 → 买点 → 打分 → 风控 → 持仓动作。
 * 一条直线的问题不是不好用，是**没法比较**：想知道"换个打分方式会不会更好"，
 * 只能改代码重跑，而改完就回不去了，两种做法的样本也永远混在一个分母里。
 *
 * 拆成槽之后，"策略"变成一组槽位实现 + 参数，于是可以并行跑、分别记账、比出胜负。
 *
 * **组合风控刻意不在槽位之列。** 单票/单行业/总仓位上限是护栏，
 * 一套激进策略若能把自己的上限改成 100%，那它在影子盘里赢的就不是别人，是风控。
 * 护栏由引擎固定施加，策略只能在 YAML 里调参数，不能换实现。
 *
 * 槽位实现受与因子层同样的约束（spec §17）：
 * 零网络、零存储访问、不取系统时间、不用随机数、无可变模块级状态。
 * 数据只能从 ctx.view 进来，"现在"只能是 ctx.date。
 */
import type { FactorRegistry, FactorResult } from "@/lib/contracts/factor";
import type { PointInTimeView } from "@/lib/contracts/pit";
import type {
  AccountId, Candidate, EnvAssessment, Phase, StrategyConfig,
} from "@/lib/contracts/strategy";

/**
 * 情绪周期阶段。
 *
 * 五段而不是四段：冰点与退潮必须分开。退潮是"该清仓"，冰点是"该建仓"，
 * 合成一段会让系统在两个完全相反的时刻给出同一个标签。
 *
 * 阶段名写死、阈值由数据学 —— 名字是人要看懂的东西，阈值是会随制度漂移的东西
 * （注册制 20cm 标的占比上升让"涨停 50 家"的含义逐年变化）。
 */
export type CycleStage = "冰点" | "启动" | "发酵" | "高潮" | "退潮";

/** 槽位参数：来自 YAML 的 `槽位.<槽名>.参数` 段，结构由各实现自己解释 */
export type SlotParams = Record<string, unknown>;

/**
 * 所有槽共享的只读上下文。
 *
 * 没有 db、没有 Date.now()、没有网络 —— 槽位能拿到的一切都在这里，
 * 这是"同一份策略代码在回测与实盘两边跑"能够成立的前提。
 */
export interface SlotCtx {
  view: PointInTimeView;
  /** 完整策略配置。槽位只该读自己那一段，但整份给出来便于过渡期复用 v1 的参数段 */
  config: StrategyConfig;
  phase: Phase;
  /**
   * 评估日。已经过 completeDate 回落 —— 盘中当日日线尚未落库，
   * 横截面因子评估的是上一个完整交易日。槽位一律用它，不许另行取"今天"。
   */
  date: string;
  registry: FactorRegistry;
  /**
   * 代码 → 行业。可选，且**没有历史版本** —— 回放早于采集时间的日期时天然带前视，
   * 所以它走参数而不是进 view（视图是冻结契约，且混进去就识别不出这层前视了）。
   * 查不到时依赖它的候选源自动关闭并告警："查不到行业"不等于"不在主线上"。
   */
  sectorOf?: (code: string) => string | null;
  /** 上面那份映射的采集时刻（上海挂钟串），用于前视告警 */
  sectorMapAt?: string;
  /** 跑一个因子；拿不到读数返回 null（已记警告）。不要绕过它直接 import 因子实现 */
  runFactor(name: string, extra?: Record<string, unknown>): FactorResult<any> | null;
  /** 上卡片的警告。缺数据、未判定、低置信一律往这里写，不许静默吞掉 */
  warn(msg: string): void;
}

/** 候选池里的一行：还没过筛、还没定价，只是"为什么值得看一眼" */
export interface PoolRow {
  code: string;
  sector: string | null;
  /** 连板数与封单额只有涨停池那一路有；另两路为 0，排序时自然靠后 */
  lbc: number;
  sealAmt: number;
  /** 进池理由。必须写进 thesis —— 三路来源的票在卡片上长得一样，不写就分不出来 */
  source: string;
}

/** 评估器的产出：已过筛、已定价、已打分，但**还没经过组合风控** */
export interface EvaluatedCandidate {
  code: string;
  name: string;
  account: AccountId;
  sector: string;
  mainline: string;
  triggerPx: number;
  stopPx: number | null;
  /** 目标位。结构位（前高/颈线/平台上沿）或 ATR 倍数；算不出来给 null */
  targetPx: number | null;
  /** 盈亏比 =(目标位 − 触发价)/(触发价 − 止损价)。任一端缺失给 null，不许填 0 */
  rrRatio: number | null;
  thesis: string;
  passedFilters: string[];
  factors: FactorResult<any>[];
  score: number;
}

interface SlotMeta {
  /** 槽位实现名，YAML 里 `用:` 引用的就是它。同一槽内不许重名 */
  name: string;
  /** 语义化版本。改了行为要升版本，否则影子盘的历史样本无法归因到具体实现 */
  version: string;
}

/** ① 择时器：今天什么环境、该有多少仓、处在周期哪一段 */
export interface TimerSlot extends SlotMeta {
  kind: "择时器";
  assess(ctx: SlotCtx, params: SlotParams, mainline: MainlineResult): {
    env: EnvAssessment;
    /** 判不出来给 undefined —— 不许猜一个，猜出来的阶段会污染影子盘的分组键 */
    stage?: CycleStage;
  };
}

/**
 * 主线识别的产出。
 *
 * factors 必须一并交出来：主线识别 / 龙头温度计这两个因子是在识别过程中求值的，
 * 而它们要出现在信号卡的 env.factors 上 —— 不交出来，卡片上就少两条归因，
 * 而人看卡片时并不知道少了。
 */
export interface MainlineResult {
  names: string[];
  factors: FactorResult<any>[];
}

/** ② 主线识别器：今天的主线是哪几条 */
export interface MainlineSlot extends SlotMeta {
  kind: "主线识别器";
  detect(ctx: SlotCtx, params: SlotParams): MainlineResult;
}

/** ③ 候选源：从哪里找票。可以挂多个，产出合并去重 */
export interface SourceSlot extends SlotMeta {
  kind: "候选源";
  scan(ctx: SlotCtx, params: SlotParams, mainlines: string[]): PoolRow[];
}

/** ④ 评估器：一行候选 → 过筛、定价、打分。返回 null 表示否决 */
export interface EvaluatorSlot extends SlotMeta {
  kind: "评估器";
  evaluate(
    ctx: SlotCtx, params: SlotParams, row: PoolRow, mainline: string
  ): EvaluatedCandidate | null;
}

/** ⑤ 离场器：持仓该持有、减半还是走 */
export interface ExitSlot extends SlotMeta {
  kind: "离场器";
  decide(
    ctx: SlotCtx, params: SlotParams,
    position: { account: AccountId; code: string; cost: number; qty: number; stopPx: number | null },
    env: EnvAssessment
  ): Candidate;
}

export type AnySlot = TimerSlot | MainlineSlot | SourceSlot | EvaluatorSlot | ExitSlot;
export type SlotKind = AnySlot["kind"];

/**
 * 槽位注册表。与 FactorRegistry 同构，理由也相同：
 * lock() 的输出要能进策略包做三重校验，所以必须**排序输出**，
 * 否则两台机器导出的同一份策略字节序不同，sha256 对不上会假报失败。
 */
export interface SlotRegistry {
  register(slot: AnySlot): void;
  get(kind: SlotKind, name: string): AnySlot | undefined;
  list(kind?: SlotKind): AnySlot[];
  /** "槽类型:实现名" -> 版本 */
  lock(): Record<string, string>;
}

/** YAML `槽位:` 段的一项 */
export interface SlotChoice {
  用: string;
  参数?: SlotParams;
}

/**
 * YAML 的 `槽位:` 段。整段可以不写 —— 不写就用 baseline 默认组合，
 * 行为与 v1 引擎一致（这是"新策略必须先打赢 baseline"能成立的前提）。
 */
export interface SlotConfig {
  择时器?: SlotChoice;
  主线识别器?: SlotChoice;
  候选源?: SlotChoice[];
  评估器?: SlotChoice;
  离场器?: SlotChoice;
}
