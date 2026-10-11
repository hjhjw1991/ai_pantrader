-- 盘中临时盯的票：这一轮还在候选池里就采它的分钟线，掉出去就停。
--
-- 为什么要有这张表：候选是每 5 分钟重算一次的（盘中板块榜在变，主线跟着变），
-- 盘前计划（prediction）写的那份是早上那一版的快照，管不了"10:40 才冒出来"
-- 的票。而分钟线是每只票一个请求、不可回补，采谁必须先有名单。
--
-- 一行 = 某只票在某天的一段盯守。掉出候选不删行：写 drop_ts 留着，
-- 复盘要看的是"它进了多久、什么时候掉的"，那才是"临时候选靠不靠谱"的证据。

CREATE TABLE IF NOT EXISTS intraday_watch (
  date     TEXT NOT NULL,
  code     TEXT NOT NULL,
  name     TEXT,
  -- 进池那一刻引擎写的买入逻辑。不记的话事后只能看到一串代码，
  -- 看不出当时是凭什么盯它 —— 而"凭什么"恰恰是要复盘的
  thesis   TEXT,
  score    REAL,
  first_ts TEXT NOT NULL,
  last_ts  TEXT NOT NULL,
  drop_ts  TEXT,                -- 掉出候选的时刻；还在盯（active=1）时为 NULL
  rounds   INTEGER NOT NULL DEFAULT 0,   -- 被盯了几轮
  active   INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (date, code)
);

-- 采集池每轮按 (date, active) 取，盘中 48 轮
CREATE INDEX IF NOT EXISTS idx_intraday_watch_live ON intraday_watch(date, active);
