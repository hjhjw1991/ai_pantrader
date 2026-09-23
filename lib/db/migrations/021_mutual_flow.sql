-- 互联互通（沪深港通）。
--
-- **北向净买额 2024-08-16 起停止披露**，这是监管口径变更，不是数据源的问题。
-- 之后北向只剩成交额（活跃度，没有方向）和十大成交股（关注度，也没有方向）。
-- 南向（内地资金买港股）的净买额仍在披露，存下来：A 股资金外流港股时它会放大。
--
-- mutual_type：001 沪股通 / 003 深股通 / 005 北向合计 / 002 港股通(沪) / 004 港股通(深) / 006 南向合计
--
-- 时点：港交所收盘后才发当日成交，所以 PIT 同样只给 date < 评估日。
-- 单位：元（东财 DEAL_HISTORY 的金额是百万元，入库前换算）。
CREATE TABLE IF NOT EXISTS mutual_deal (
  date         TEXT NOT NULL,
  mutual_type  TEXT NOT NULL,
  deal_amt     REAL,
  -- 2024-08-16 之后北向恒为 NULL。NULL 是"不再披露"，**不是 0**
  net_amt      REAL,
  PRIMARY KEY (date, mutual_type)
);

-- 北向十大成交股（沪股通、深股通各 10 只）。
-- 净买额同样已停披露，只剩成交额与"北向成交占该股总成交的比例"。
CREATE TABLE IF NOT EXISTS mutual_top10 (
  date         TEXT NOT NULL,
  mutual_type  TEXT NOT NULL,
  code         TEXT NOT NULL,
  rank         INTEGER,
  deal_amt     REAL,
  -- 北向成交额占该股当日总成交，小数
  mutual_ratio REAL,
  PRIMARY KEY (date, mutual_type, code)
);

CREATE INDEX IF NOT EXISTS idx_mutual_top10_code ON mutual_top10(code, date);
