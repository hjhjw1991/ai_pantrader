-- 限售股解禁日历。
--
-- 与估值、涨停池不同，这张表**可以回补**：解禁日在限售股发行时就定了，
-- 东财给的是一份覆盖 2010 → 2035 的完整日历，随时重拉都拿得到同样的历史。
--
-- 能用来回测的理由：首发限售 1~3 年、定增 6~18 个月，所以"未来 90 天有没有解禁"
-- 在评估日那天几乎总是已知的。残余前视只来自"评估日之后才完成的定增"，
-- 那批股份的解禁日离评估日至少半年，很少落进 90 天窗口。
--
-- 单位统一成 股 / 元 / 小数比例（东财原始是 万股 / 万元 / 小数）。
CREATE TABLE IF NOT EXISTS lift_schedule (
  code        TEXT NOT NULL,
  free_date   TEXT NOT NULL,
  -- 同一天可能有多批不同类型的限售股解禁，所以类型进主键
  share_type  TEXT NOT NULL,
  free_shares REAL,
  lift_mktcap REAL,
  -- 占解禁前流通股的比例，小数。解禁压力主要看它
  free_ratio  REAL,
  total_ratio REAL,
  PRIMARY KEY (code, free_date, share_type)
);

CREATE INDEX IF NOT EXISTS idx_lift_code_date ON lift_schedule(code, free_date);
