/**
 * 台账 / 自校准闭环（spec §11）。
 *
 * 诚实定义，别改口径：这不是模型自训练，是规则库 + 参数随实盘对账进化。
 * 目标只有一个 —— 同一个错误不重复犯。它不承诺预测更准。
 *
 * 五步链条，每一步都可单独调用：
 *   1 record      信号落台账（含 eval_horizon / valid_until / advisor_influenced）
 *   2 reconcile   到期对账，拿不到真价就不结算
 *   3 attribution 偏差归入固定四类错因（闭枚举，能计数才能驱动后面两步）
 *   4 suggest     某类错误超频 → 出参数建议（只出建议，不改 YAML）
 *   5 winrate / dashboard  胜率与切片，含 Advisor 的 A/B 对比
 *   6 review      推荐质量复盘：触发率 / 胜率 / 盈亏比 三关分开报
 */
export * from "@/lib/ledger/query";
export * from "@/lib/ledger/record";
export * from "@/lib/ledger/reconcile";
export * from "@/lib/ledger/attribution";
export * from "@/lib/ledger/winrate";
export * from "@/lib/ledger/suggest";
export * from "@/lib/ledger/dashboard";
export * from "@/lib/ledger/review";
