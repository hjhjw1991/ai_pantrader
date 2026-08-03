-- 龙虎榜重建。原实现（001）有三处静默丢数据，2026-08-03 实测：
--
-- 1. PRIMARY KEY (date, code) 把同一只票的多条上榜原因折叠成一条。
--    实测当日抓到 58 行只存下 30 行 —— 丢 48%。利欧股份(002131) 同日三条：
--    "日换手率达到20%的前5只证券" / "日涨幅偏离值达到7%的前5只证券" /
--    "连续三个交易日内，涨幅偏离值累计达到20%的证券"，净买额不同，全被覆盖成一条。
--    实测 (date, code, change_type) 在 07-29/07-30/07-31/08-03 四天上唯一（90/119/83/58 行零折叠）。
--
-- 2. 把 EXPLAIN 当成了上榜原因。EXPLAIN 是统计口径 blurb（"3家机构买入，成功率38.45%"），
--    真正的上榜原因在 EXPLANATION。资金因子按错字段聚类会得出无意义的簇。
--
-- 3. 丢掉了席位、换手、成交占比。spec §8 的"游资席位识别"正是靠营业部明细，
--    在 RPT_BILLBOARD_DAILYDETAILSBUY/SELL，可整日一次拉完（实测 290 行 / 1 请求）。
--
-- 旧表数据全部可回补（东财按历史日期开放），且当时只有今日 30 行残缺数据，直接重建。

DROP TABLE IF EXISTS lhb;

CREATE TABLE lhb (
  date         TEXT NOT NULL,
  code         TEXT NOT NULL,
  change_type  TEXT NOT NULL,   -- 上榜类型代码，行身份的一部分，不是附属字段
  trade_id     INTEGER,         -- 东财行 id
  name         TEXT,
  explanation  TEXT,            -- 真正的上榜原因
  explain_stat TEXT,            -- EXPLAIN：机构家数 / 3日成功率统计
  net_amt      REAL,
  buy_amt      REAL,
  sell_amt     REAL,
  billboard_deal_amt REAL,      -- 龙虎榜成交额
  deal_amount_ratio  REAL,      -- 龙虎榜成交占全日成交比
  deal_net_ratio     REAL,
  buy_seat_raw  TEXT,           -- BUY_SEAT_NEW 原值。含义未证实，原样留存不解释
  sell_seat_raw TEXT,
  buy_ratio    REAL,
  sell_ratio   REAL,
  close_price  REAL,
  change_rate  REAL,
  turnover_rate REAL,
  accum_amount REAL,
  free_market_cap REAL,
  trade_market TEXT,
  -- 后续涨跌幅是天然监督标签，但上榜当日全为 null，随时间回填 → night job 需滚动重拉
  d1_chg REAL, d2_chg REAL, d5_chg REAL, d10_chg REAL, d20_chg REAL, d30_chg REAL,
  PRIMARY KEY (date, code, change_type)
);

CREATE INDEX IF NOT EXISTS idx_lhb_code_date ON lhb(code, date);
CREATE INDEX IF NOT EXISTS idx_lhb_date ON lhb(date);

-- 营业部席位明细。
-- 没有稳定业务主键：机构专用席位全部共用 OPERATEDEPT_CODE='0'，
-- 实测 290 行按 (code, change_type, dept_code) 去重只剩 251 —— 用业务键做 PK 必然丢 39 行。
-- 故用代理主键，幂等靠"按 (date, side) 先删后插"，不靠 UPSERT。
CREATE TABLE IF NOT EXISTS lhb_seat (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  date         TEXT NOT NULL,
  code         TEXT NOT NULL,
  change_type  TEXT NOT NULL,
  side         TEXT NOT NULL,   -- buy | sell（上榜买方榜 / 卖方榜）
  dept_code    TEXT,
  dept_name    TEXT,
  buy_amt      REAL,
  sell_amt     REAL,
  net_amt      REAL,
  buy_ratio    REAL,            -- TOTAL_BUYRIO：占全日成交比
  sell_ratio   REAL,
  rise_prob_3d REAL,            -- 该席位近 3 日买入后上涨概率，游资识别用
  buyer_times_3d INTEGER
);

CREATE INDEX IF NOT EXISTS idx_lhb_seat_date ON lhb_seat(date, side);
CREATE INDEX IF NOT EXISTS idx_lhb_seat_code ON lhb_seat(code, date);
CREATE INDEX IF NOT EXISTS idx_lhb_seat_dept ON lhb_seat(dept_name, date);
