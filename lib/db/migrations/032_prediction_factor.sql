/**
 * 推荐 → 因子读数 绑定表（P1：让台账能被逐因子归因）。
 *
 * 之前 prediction 表唯一承载"为什么推荐"的是自由文本 thesis，因子读数一个都没落库 ——
 * 于是 IC、分位数分组、横截面回归全部无从下手，"该给哪个因子多少权重"只能靠拍
 * （engine.ts 里那 5 个权重至今是手写的常数）。
 *
 * 这张表把引擎当场算出的 FactorResult（name / version / value / label / confidence）
 * 和那一条推荐绑在一起。它是**不可再生**的学习样本：因子算法会升版
 * （FactorResult.version 就是为此存在的），今天重跑给不出历史上那一版读数，
 * 而归因要问的正是"当时那个读数预示了什么"。
 *
 * scope 区分个股与环境：同一个名字在两个域里含义不同（如"情绪"），
 * 主键带上 scope 才不会互相覆盖。
 */
CREATE TABLE IF NOT EXISTS prediction_factor (
  pred_id     TEXT NOT NULL,
  factor_name TEXT NOT NULL,
  scope       TEXT NOT NULL,          -- 'stock' 个股 | 'env' 环境
  version     TEXT,                   -- 因子算法版本；改算法必须升版，否则历史结论无法归因
  value       REAL,                   -- 数值读数；定性因子（只有 label）留 NULL，不硬转 0
  label       TEXT,                   -- 人读标签，如 "多头" / "放量 1.8x"
  confidence  REAL,                   -- 0~1；数据缺失、样本不足、代理重建都会降
  created_at  TEXT NOT NULL,
  PRIMARY KEY (pred_id, factor_name, scope)
);

-- 按因子名取全历史读数：IC / 分位数 / 横截面回归都从"某个因子的时间序列"出发
CREATE INDEX IF NOT EXISTS idx_prediction_factor_lookup
  ON prediction_factor(factor_name, scope);
