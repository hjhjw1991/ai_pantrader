-- 策略 / 信号 / 台账 / 账户。M1–M5 六个方向共用，先建表冻结结构，避免各自另建一套。
-- 对应 spec §7 的"策略与信号"与"账户"两段。

CREATE TABLE IF NOT EXISTS strategy (
  id          TEXT NOT NULL,
  version     TEXT NOT NULL,
  yaml        TEXT NOT NULL,       -- YAML 是唯一真相源（D7），面板只是它的投影
  factors_lock TEXT,               -- JSON: 因子名 -> 版本，防导入后语义漂移
  created_at  TEXT NOT NULL,
  active      INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (id, version)
);

CREATE TABLE IF NOT EXISTS watchpool (
  code        TEXT PRIMARY KEY,
  name        TEXT,
  account     TEXT,                -- 贼王 | 价值
  trigger_px  REAL,
  stop_px     REAL,
  thesis      TEXT,
  added_at    TEXT NOT NULL,
  active      INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS prediction (
  id          TEXT PRIMARY KEY,
  ts          TEXT NOT NULL,
  phase       TEXT NOT NULL,       -- 盘前 | 盘中 | 盘后
  code        TEXT NOT NULL,
  strategy_id TEXT NOT NULL,
  action      TEXT NOT NULL,
  account     TEXT,
  trigger_px  REAL,
  stop_px     REAL,
  size        REAL,
  thesis      TEXT,
  gear        TEXT,
  eval_horizon INTEGER NOT NULL,   -- 对齐龙虎榜 D1/D5/D10/D20/D30
  valid_until TEXT NOT NULL,
  advisor_influenced INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_prediction_ts ON prediction(ts);
CREATE INDEX IF NOT EXISTS idx_prediction_code ON prediction(code, ts);
-- 到期对账 job 靠这个索引找该结算的预测
CREATE INDEX IF NOT EXISTS idx_prediction_valid ON prediction(valid_until);

CREATE TABLE IF NOT EXISTS outcome (
  pred_id     TEXT PRIMARY KEY REFERENCES prediction(id),
  verdict     TEXT NOT NULL,       -- 命中 | 偏差 | 中性
  actual_pct  REAL,
  error_type  TEXT,                -- 固定枚举，不许自由文本，否则聚类统计没意义
  attribution TEXT,
  settled_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_outcome_error ON outcome(error_type);

CREATE TABLE IF NOT EXISTS advisor_output (
  ts          TEXT NOT NULL,
  code        TEXT NOT NULL DEFAULT '',   -- 环境级建议不针对个股，留空串
  slot        TEXT NOT NULL,
  value       TEXT,                -- JSON
  mode        TEXT NOT NULL,       -- null | claude-cli | claude-api
  model       TEXT,
  prompt_hash TEXT NOT NULL,       -- 换提示词 = 换实验条件，必须能分辨
  input_snapshot_hash TEXT NOT NULL,
  confidence  REAL,
  degraded    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (ts, code, slot)
);

CREATE TABLE IF NOT EXISTS account (
  id     TEXT PRIMARY KEY,
  name   TEXT NOT NULL,
  type   TEXT NOT NULL             -- 贼王 | 价值
);

CREATE TABLE IF NOT EXISTS position (
  account_id TEXT NOT NULL REFERENCES account(id),
  code       TEXT NOT NULL,
  cost       REAL NOT NULL,
  qty        REAL NOT NULL,
  open_date  TEXT NOT NULL,
  stop_px    REAL,
  thesis     TEXT,
  PRIMARY KEY (account_id, code)
);

CREATE TABLE IF NOT EXISTS trade (
  id         TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES account(id),
  code       TEXT NOT NULL,
  side       TEXT NOT NULL,        -- buy | sell
  px         REAL NOT NULL,
  qty        REAL NOT NULL,
  ts         TEXT NOT NULL,
  fee        REAL NOT NULL DEFAULT 0,
  source     TEXT NOT NULL,        -- manual | paper | live
  prediction_id TEXT
);

CREATE INDEX IF NOT EXISTS idx_trade_account_ts ON trade(account_id, ts);

CREATE TABLE IF NOT EXISTS ord (
  id          TEXT PRIMARY KEY,
  ts          TEXT NOT NULL,
  account_id  TEXT NOT NULL,
  code        TEXT NOT NULL,
  side        TEXT NOT NULL,
  px          REAL NOT NULL,
  qty         REAL NOT NULL,
  status      TEXT NOT NULL,       -- pending|submitted|filled|partial|cancelled|rejected
  prediction_id TEXT
);

CREATE INDEX IF NOT EXISTS idx_ord_status ON ord(status, ts);
