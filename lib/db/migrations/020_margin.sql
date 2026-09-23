-- 融资融券（两融）。
--
-- 两张表：全市场每日汇总、个股每日明细。东财 RPTA_RZRQ_LSHJ / RPTA_WEB_RZRQ_GGMX，
-- 2010 年起有完整历史，**可以回补**。
--
-- 关键的时点约束：交易所在 T+1 开盘前才公布 T 日的两融数据。
-- 所以 PIT 查询只能看到 **date < 评估日** 的行 —— 评估日当天收盘后的卡片上，
-- 最新一条两融是昨天的。用了当天的就是未来函数（回测里尤其隐蔽：数据确实在库里）。
--
-- 单位统一成 元 / 股 / 小数比例（东财的 RZYEZB 是百分数，入库前除以 100）。
CREATE TABLE IF NOT EXISTS margin_market (
  date    TEXT PRIMARY KEY,
  -- 融资余额 / 融券余额 / 两融余额，元
  rzye    REAL,
  rqye    REAL,
  rzrqye  REAL,
  -- 融资买入额 / 融资偿还额 / 融资净买入，元
  rzmre   REAL,
  rzche   REAL,
  rzjme   REAL,
  -- 融资余额占流通市值，小数
  rzyezb  REAL,
  -- 流通市值，元
  ltsz    REAL
);

CREATE TABLE IF NOT EXISTS margin_stock (
  date    TEXT NOT NULL,
  code    TEXT NOT NULL,
  rzye    REAL,
  rzmre   REAL,
  rzche   REAL,
  rzjme   REAL,
  rqye    REAL,
  -- 融券余量，股
  rqyl    REAL,
  rzrqye  REAL,
  -- 融资余额占流通市值，小数。杠杆资金的拥挤度主要看它
  rzyezb  REAL,
  PRIMARY KEY (date, code)
);

CREATE INDEX IF NOT EXISTS idx_margin_stock_code ON margin_stock(code, date);
