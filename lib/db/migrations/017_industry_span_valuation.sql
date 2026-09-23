-- 行业归属的时间区间，由 sw_industry_snapshot 差分推出。
--
-- 为什么要这张派生表：快照表回答"某次采集时这只票属于哪个行业"，
-- 而回测要问的是"2024-03-15 这天它属于哪个行业"。后者要靠相邻快照差分。
--
-- 关键一点：**变更日期是精确的，不打折**。申万的 beginningdate 给的就是计入日，
-- 所以差分只负责"发现变了、上一个是谁"，定日靠 beginningdate。
-- 周频快照的 ≤7 天滞后只影响**发现**的及时性，不影响区间端点的准确性。
--
-- to_date 为 NULL = 至今有效。区间按 [from_date, to_date) 半开理解。
CREATE TABLE IF NOT EXISTS sw_industry_span (
  code       TEXT NOT NULL,
  level      INTEGER NOT NULL,
  index_code TEXT NOT NULL,
  index_name TEXT NOT NULL,
  from_date  TEXT NOT NULL,
  to_date    TEXT,
  PRIMARY KEY (code, level, from_date)
);

CREATE INDEX IF NOT EXISTS idx_sw_span_lookup ON sw_industry_span(code, level, from_date);

-- 估值快照。
--
-- **只有当日，没有历史**：东财的 clist 给的是此刻的 PE/PB，没有历史接口。
-- 所以这张表从接入那天起往前攒，2026-09-23 之前一片空白，且永远补不回来。
-- 回测跑到更早的日期时，估值类判据必须如实返回"无数据"，不许拿今天的 PE 回刷 ——
-- 那是典型的未来函数，而且偏向"今天看起来便宜"的票。
--
-- 不存分位数：分位依赖全市场横截面，存进来等于把口径焊死。
-- 因子层拿当日全市场的 PE 现算分位，换口径不必重灌数据。
CREATE TABLE IF NOT EXISTS valuation_daily (
  code    TEXT NOT NULL,
  date    TEXT NOT NULL,
  -- 东财 clist 的 f9。亏损股为负，**不要**当成"便宜"
  pe      REAL,
  -- f23
  pb      REAL,
  -- f20 / f21，单位元
  mktcap  REAL,
  float_mktcap REAL,
  PRIMARY KEY (code, date)
);

CREATE INDEX IF NOT EXISTS idx_valuation_date ON valuation_daily(date);
