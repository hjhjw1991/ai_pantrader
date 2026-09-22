-- 周线 / 月线。
--
-- 为什么本地聚合而不是直接采东财的 klt=102/103：**跨源的复权算法不一致**。
--
-- 实测 2026-09-22，以浦发(600000)为例，东财与新浪的后复权序列：
-- 1999 年完全吻合，2005 年差 2.5%，2026 年差 61%，且比值随时间漂移
-- —— 意味着两条序列的涨跌幅本身就不同，不是简单的缩放差异。
--
-- 而库里的日线是新浪的。若日线用新浪因子复权、周月线直接取东财后复权，
-- 日线 MACD 与周线 MACD 就跑在两条不同的价格序列上。这种不一致是**静默的**：
-- 不报错，只让多周期共振判断时对时错，而且查不出为什么。
--
-- 本地聚合的代价是要自己处理周/月边界（停牌周、跨年周），但那是**可测试**的；
-- 跨源不一致是不可见的。何况交易日历表本来就有，按它切边界比 ISO 周更准。
--
-- 存的是**后复权**价：这张表只服务于技术指标（MACD/均线/形态），
-- 而触发价与涨跌停判定一律走 kline_daily 的原始价，两者不可混用。
CREATE TABLE IF NOT EXISTS kline_period (
  code   TEXT NOT NULL,
  -- 'W' 周线 / 'M' 月线
  period TEXT NOT NULL,
  -- 该周/该月**最后一个交易日**的日期。用收盘日而不是起始日，
  -- 是为了让 "date <= asOf" 这条 PIT 过滤天然成立：一根还没走完的周线
  -- 其收盘日在未来，于是自动不可见，不必另写特判。
  date   TEXT NOT NULL,
  o REAL, h REAL, l REAL, c REAL, vol REAL, amount REAL,
  PRIMARY KEY (code, period, date)
);

CREATE INDEX IF NOT EXISTS idx_kline_period_code ON kline_period(code, period, date);
