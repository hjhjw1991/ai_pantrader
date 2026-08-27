import type { FactorResult } from "@/lib/contracts/factor";
import type { PointInTimeView } from "@/lib/contracts/pit";

/** 仓位档位。防守档 = 0 仓，不是"轻仓"。 */
export type EnvGear = "进攻" | "中性" | "防守";

export type Phase = "盘前" | "盘中" | "盘后";

/**
 * 账户标识。**由用户自己定义**，代码里不预设任何账户名。
 *
 * 早期版本把它写成两个内置账户名的联合类型，那意味着加一个账户、改一个名字
 * 都要改代码并跑一遍编译 —— 账户是用户的资产组织方式，不是程序的枚举。
 *
 * 现在的分工：
 *   账户清单   → `account` 表，用户在设置页增删改（数据）
 *   每账户规则 → strategy.yaml 的 `持仓` 段，按账户 id 作键（策略参数，D7 唯一真相源）
 *
 * 不同账户的止损语义可以完全不同（吃波动的按比例止损、扛逻辑的按逻辑破坏），
 * 所以规则必须按账户分开配，不能共用一套 —— 但"分成哪几个账户"是用户的决定。
 */
export type AccountId = string;

/** @deprecated 用 AccountId。保留别名避免调用点一次性全改。 */
export type AccountType = AccountId;

export interface EnvAssessment {
  gear: EnvGear;
  /** 该档位对应的目标总仓位 0~1 */
  targetPosition: number;
  /** 触发这个档位的具体条件，给人看的归因 */
  reasons: string[];
  factors: FactorResult<any>[];
  /** 有低置信因子参与决策时列出来，不藏（spec §10.3） */
  lowConfidenceFactors: string[];
}

export type Action = "买入" | "加仓" | "减仓" | "清仓" | "持有" | "观察";

export interface Candidate {
  code: string;
  name: string;
  action: Action;
  account: AccountType;
  /** 触发价：到价才动手，不是市价追。null = 无条件（仅用于清仓类动作） */
  triggerPx: number | null;
  stopPx: number | null;
  /** 建议仓位占总资产比例 0~1 */
  size: number;
  /** 买入逻辑一句话。写不出来的不许进候选池 */
  thesis: string;
  /** 命中/否决的过滤器，供复盘 */
  passedFilters: string[];
  rejectedBy?: string[];
  factors: FactorResult<any>[];
  score: number;
}

export interface SignalCard {
  ts: string;
  phase: Phase;
  strategyId: string;
  env: EnvAssessment;
  candidates: Candidate[];
  /** 持仓动作与新开仓分开，早上照着做不用再想 */
  holdings: Candidate[];
  /** 数据覆盖率警告：有缺口就必须出现在卡上 */
  warnings: string[];
  advisorInfluenced: boolean;
}

/**
 * 策略配置。YAML 是唯一真相源（D7）：参数面板改动写回 YAML，不存在第二份状态。
 * 这里只定结构，取值范围校验由 loader 负责，导入非法值要报出具体行号（spec §9.2）。
 */
export interface StrategyConfig {
  id: string;
  version: string;
  择时: {
    仓位档位: Record<EnvGear, number>;
    防守触发: Record<string, unknown>;
  };
  选股: {
    过滤器阈值: Record<string, number>;
    /**
     * 候选从哪几路来。三路都要过同一道主线筛与七道筛，只是"进池"的理由不同：
     *   涨停池   —— 昨日涨停（强度最直接的证据）
     *   主线领涨 —— 主线板块涨幅榜上那只领涨股
     *   量价     —— 主线板块成分里放量突破且均线多头排列的
     * 缺省全开。任一路关掉都只是少一个来源，不改变后面的筛与触发价逻辑。
     */
    候选来源?: { 涨停池?: boolean; 主线领涨?: boolean; 量价?: boolean };
    /** 量价那一路的阈值。不配就用引擎默认值 */
    量价条件?: {
      均量窗口?: number;
      放量倍数?: number;
      新高窗口?: number;
      多头排列?: boolean;
    };
    主线识别: {
      板块涨幅榜TopN: number;
      /**
       * 必查链写死，不做成可关闭参数（spec §8.2）。
       * 板块榜均值会掩盖链内龙头封板，这是 2026-07-27 主线级漏扫的根因。
       */
      必查链: string[];
    };
  };
  持仓: Record<AccountType, Record<string, unknown>>;
  组合风控: {
    总仓位上限: number;
    单票最大占比: number;
    单行业最大占比: number;
    核心卫星比例: { 核心: number; 卫星: number };
  };
  /** 因子参数覆盖：因子名 -> 参数段 */
  因子参数?: Record<string, Record<string, unknown>>;
}

export interface StrategyEngineInput {
  view: PointInTimeView;
  config: StrategyConfig;
  phase: Phase;
  /** 当前持仓，用于产出持仓动作 */
  positions: Array<{ account: AccountType; code: string; cost: number; qty: number; stopPx: number | null }>;
  /**
   * 代码 → 行业板块。可选。
   *
   * 走输入而不是往 PointInTimeView 上加方法：视图是冻结契约（gapKinds 当初也是
   * 为此另开的函数）。而且这份映射与视图的其余数据性质不同 —— 它是**当前**的行业归属，
   * 没有历史版本，所以回放历史时它天然带一点前视，必须能被单独识别和告警，
   * 混进视图里就看不出来了。
   *
   * 不给（或查不到某只票）时，依赖它的候选来源自动关闭，并在卡片上说明 ——
   * "查不到行业"不等于"不在主线上"。
   */
  sectorOf?: (code: string) => string | null;
  /** 上面那份映射是什么时候采的（上海挂钟串），用于前视告警。不给就不告警 */
  sectorMapAt?: string;
}

export type StrategyEngine = (input: StrategyEngineInput) => SignalCard;
