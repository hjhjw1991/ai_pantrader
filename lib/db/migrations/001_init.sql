-- 行情
CREATE TABLE IF NOT EXISTS kline_daily (
  code TEXT NOT NULL, date TEXT NOT NULL,
  o REAL, h REAL, l REAL, c REAL, vol REAL, amount REAL,
  adj_factor REAL DEFAULT 1.0,
  PRIMARY KEY (code, date)
);

CREATE TABLE IF NOT EXISTS kline_min (
  code TEXT NOT NULL, ts TEXT NOT NULL, period TEXT NOT NULL,
  o REAL, h REAL, l REAL, c REAL, vol REAL,
  PRIMARY KEY (code, ts, period)
);

CREATE TABLE IF NOT EXISTS quote_snapshot (
  ts TEXT NOT NULL, code TEXT NOT NULL,
  price REAL, pct REAL, turnover REAL, amplitude REAL, bid_ask_json TEXT,
  PRIMARY KEY (ts, code)
);

-- 截面（不可回补）
CREATE TABLE IF NOT EXISTS zt_pool (
  date TEXT NOT NULL, code TEXT NOT NULL, name TEXT,
  lbc INTEGER, seal_amt REAL, open_times INTEGER,
  first_seal_ts TEXT, last_seal_ts TEXT, sector TEXT, turnover REAL,
  PRIMARY KEY (date, code)
);

CREATE TABLE IF NOT EXISTS dt_pool (
  date TEXT NOT NULL, code TEXT NOT NULL, name TEXT, seal_amt REAL,
  PRIMARY KEY (date, code)
);

CREATE TABLE IF NOT EXISTS sector_rank (
  date TEXT NOT NULL, ts TEXT NOT NULL, sector TEXT NOT NULL,
  pct REAL, leader_code TEXT,
  PRIMARY KEY (date, ts, sector)
);

CREATE TABLE IF NOT EXISTS lhb (
  date TEXT NOT NULL, code TEXT NOT NULL, name TEXT,
  net_amt REAL, buy_amt REAL, sell_amt REAL, explanation TEXT,
  d1_chg REAL, d5_chg REAL, d10_chg REAL,
  PRIMARY KEY (date, code)
);

CREATE TABLE IF NOT EXISTS macro (
  ts TEXT NOT NULL, symbol TEXT NOT NULL, price REAL, pct REAL,
  PRIMARY KEY (ts, symbol)
);

-- 元数据
CREATE TABLE IF NOT EXISTS security (
  code TEXT PRIMARY KEY, name TEXT,
  list_date TEXT, delist_date TEXT, board TEXT,
  is_st_history_json TEXT
);

CREATE TABLE IF NOT EXISTS trading_calendar (
  date TEXT PRIMARY KEY, is_open INTEGER NOT NULL, source TEXT
);

CREATE TABLE IF NOT EXISTS data_gap (
  date TEXT NOT NULL, source TEXT NOT NULL, kind TEXT NOT NULL,
  reason TEXT, recoverable INTEGER NOT NULL, detected_at TEXT,
  resolved_at TEXT,
  PRIMARY KEY (date, source, kind)
);

CREATE TABLE IF NOT EXISTS source_health (
  source TEXT NOT NULL, ts TEXT NOT NULL,
  ok INTEGER NOT NULL, latency_ms INTEGER, err TEXT,
  PRIMARY KEY (source, ts)
);

CREATE INDEX IF NOT EXISTS idx_kline_daily_date ON kline_daily(date);
CREATE INDEX IF NOT EXISTS idx_quote_snapshot_code ON quote_snapshot(code);
CREATE INDEX IF NOT EXISTS idx_data_gap_unresolved ON data_gap(resolved_at);
