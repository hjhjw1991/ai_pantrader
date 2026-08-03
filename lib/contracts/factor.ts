import type { PointInTimeView } from "@/lib/contracts/pit";

/**
 * 因子 = 纯函数。同一个 view + 同一份 params 必须永远得到同一个结果
 * （spec §17 断言 4：同份历史输入跑两次回测结果哈希一致）。
 *
 * 禁止：网络请求、读 DB、Date.now()、Math.random()、可变模块级状态。
 */

export interface FactorContext {
  view: PointInTimeView;
  /** 来自 strategy.yaml 的该因子参数段 */
  params: Record<string, unknown>;
}

/**
 * confidence 不是摆设。情绪类因子由日线代理重建，不是真值（spec §10.3）：
 * 满 60 交易日后跑 proxy-vs-real 相关性审计，ρ<0.8 的因子要在回测报告首页标红。
 * 代理重建出来的值一律标 "proxy"。
 */
export type Provenance = "real" | "proxy";

export interface FactorResult<T = number> {
  name: string;
  /** 语义化版本。改了算法就要升版，否则历史回测结论无法归因 */
  version: string;
  value: T;
  /** 给人看的标签，如 "情绪过热" / "缩量洗盘" */
  label?: string;
  provenance: Provenance;
  /** 0~1。数据缺失、样本不足、代理重建都要降 */
  confidence: number;
  /** 算这个值用到了哪些原始输入，供归因与复现 */
  inputs?: Record<string, unknown>;
}

export type FactorFn<T = number> = (ctx: FactorContext) => FactorResult<T>;

export interface FactorSpec<T = number> {
  name: string;
  version: string;
  /** 环境 / 过滤器 / 技术 / 资金 / 温度计 */
  group: "env" | "filter" | "tech" | "fund" | "thermo";
  /** 默认参数，也是参数面板的取值范围来源 */
  defaults: Record<string, unknown>;
  fn: FactorFn<T>;
}

/** 因子注册表。策略 YAML 靠名字引用因子，.ptstrat 的 factors.lock 靠它校验版本 */
export interface FactorRegistry {
  register(spec: FactorSpec<any>): void;
  get(name: string): FactorSpec<any> | undefined;
  list(): FactorSpec<any>[];
  /** name -> version，导出策略包时写进 factors.lock */
  lock(): Record<string, string>;
}
