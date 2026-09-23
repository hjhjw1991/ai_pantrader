-- 重要股东**已实施**的增减持（东财 RPT_SHARE_HOLDER_INCREASE，1994 年起）。
--
-- 与 reduction_plan 的分工：那张是"计划要减"（未来的抛压，只能从接入日起攒），
-- 这张是"已经减了"（过去的事实，**可以回补**，所以能进回测）。
--
-- PIT 时点用公告日 notice_date：减持实施后要公告才为市场所知。
-- 东财常见"晚间发布、公告日记为次一交易日"，所以 notice_date <= 评估日 是保守的。
--
-- 单位：股 / 小数比例（东财的 CHANGE_NUM 是万股、各比例是百分数，入库前换算）。
-- change_free_ratio 带符号：增持为正、减持为负，下游直接求和即净额。
CREATE TABLE IF NOT EXISTS holder_change (
  code              TEXT NOT NULL,
  holder            TEXT NOT NULL,
  direction         TEXT NOT NULL,
  start_date        TEXT NOT NULL,
  end_date          TEXT NOT NULL,
  notice_date       TEXT NOT NULL,
  change_shares     REAL,
  change_free_ratio REAL,
  -- 变动后持股占总股本，小数
  after_hold_ratio  REAL,
  -- 二级市场 / 大宗交易 / 协议转让 …
  market            TEXT,
  PRIMARY KEY (code, holder, start_date, end_date, direction)
);

CREATE INDEX IF NOT EXISTS idx_holder_change_code ON holder_change(code, notice_date);
