-- 情绪截面派生表：每个交易日一行，由日线本地重建（lib/factors/sentiment.ts）。
--
-- 为什么要落表而不是现算：五段状态机的阈值来自滚动 250 日分位，
-- 现算一天约 0.3 秒，每次评估都要回头算 250 天就是 75 秒 —— 实盘等不起，回测更等不起。
--
-- 无前视：每一行只用那天及以前的日线算出，PIT 视图按 date <= 评估日截断。
-- algo_version 记口径版本：口径一改，夜间任务重算版本不符的行，
-- 否则新旧两种口径混在同一条分位序列里，学出来的阈值两边都不像。
--
-- 单位：家数整数；比率 [0,1]；涨幅与溢价为百分点。分母为 0 时为 NULL（不是 0）。
CREATE TABLE IF NOT EXISTS sentiment_daily (
  date           TEXT PRIMARY KEY,
  up             INTEGER NOT NULL,
  down           INTEGER NOT NULL,
  flat           INTEGER NOT NULL,
  unknown        INTEGER NOT NULL,
  median_pct     REAL,
  avg_pct        REAL,
  zt             INTEGER NOT NULL,
  dt             INTEGER NOT NULL,
  zb             INTEGER NOT NULL,
  zb_rate        REAL,
  max_lbc        INTEGER NOT NULL,
  lb_count       INTEGER NOT NULL,
  first_prev     INTEGER NOT NULL,
  first_promo    REAL,
  multi_prev     INTEGER NOT NULL,
  multi_promo    REAL,
  zt_prem        REAL,
  zt_open_prem   REAL,
  first_prem     REAL,
  multi_prem     REAL,
  zb_prem        REAL,
  high_lbc_prev  INTEGER NOT NULL,
  high_prem      REAL,
  algo_version   TEXT NOT NULL,
  built_at       TEXT NOT NULL
);
