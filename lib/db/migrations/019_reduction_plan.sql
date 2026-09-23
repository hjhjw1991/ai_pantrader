-- 股东增减持计划（预披露）。
--
-- 来源是同花顺 F10 事件页的模板句，东财 datacenter 没有这张报表（实测）。
-- 同花顺每只票只保留最近约 2 条，所以这张表**只能从接入那天起往前攒**，
-- 做不了深回测。
--
-- first_seen 是我们第一次看到这条计划的日期，也是 PIT 查询唯一可信的时点：
-- 源里没有逐条的公告日，拿计划起始日倒推（新规要求预披露后 15 个交易日才能减）
-- 在老公告与特殊情形下不可靠。宁可说"我们从 X 日才知道"，也不要猜一个更早的日期 ——
-- 猜早了就是未来函数。
CREATE TABLE IF NOT EXISTS reduction_plan (
  code        TEXT NOT NULL,
  actor       TEXT NOT NULL,
  -- '增持' / '减持'。增持也存：它是有用的反向信号，只是不进风险判据
  direction   TEXT NOT NULL,
  start_date  TEXT NOT NULL,
  end_date    TEXT NOT NULL,
  max_shares  REAL,
  -- 占总股本比例上限，小数
  max_ratio   REAL,
  first_seen  TEXT NOT NULL,
  PRIMARY KEY (code, actor, start_date)
);

CREATE INDEX IF NOT EXISTS idx_reduction_plan_code ON reduction_plan(code, end_date);
