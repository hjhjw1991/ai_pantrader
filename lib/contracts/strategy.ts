import type { FactorResult } from "@/lib/contracts/factor";
import type { PointInTimeView } from "@/lib/contracts/pit";

/** 仓位档位。防守档 = 0 仓，不是"轻仓"。 */
export type EnvGear = "进攻" | "中性" | "防守";

export type Phase = "盘前" | "盘中" | "盘后";

/** 两个账户语义完全不同：贼王吃波动、价值扛逻辑，止损规则不可混用。 */
export type AccountType = "贼王" | "价值";

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
}

export type StrategyEngine = (input: StrategyEngineInput) => SignalCard;
