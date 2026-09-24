-- 代理截面：由日线 + 申万行业历史归属重建的涨停名单与行业涨幅榜。
--
-- 为什么要：真涨停池 2026-08-03 起、板块榜 2026-08-27 起才开始攒。主线识别与候选池
-- 全靠这两样，于是更早的每一天主线都是空的、候选池都是空的 —— 回测与影子盘冷启动
-- 在那段历史上等于什么都没做。
--
-- 只在**那天没有真快照**时才用（用户 2026-09-24 选定）。用了要在因子结果上标 proxy、降置信。
-- 名字用申万三级行业名，与东财的概念 / 行业板块不是一套 —— 代理日的主线会偏"行业"而非"概念"。
-- 日线里没有封单额、开板次数，这两列不存在，不编。
--
-- 无前视：每一行只用那天及以前的日线与那天的行业归属。

CREATE TABLE IF NOT EXISTS zt_proxy (
  date    TEXT NOT NULL,
  code    TEXT NOT NULL,
  lbc     INTEGER NOT NULL,
  -- 申万三级行业名；那天查不到归属时为 NULL
  sector  TEXT,
  PRIMARY KEY (date, code)
);

CREATE TABLE IF NOT EXISTS sector_rank_proxy (
  date         TEXT NOT NULL,
  sector       TEXT NOT NULL,
  -- 成分股当日涨跌幅（复权）的等权平均，百分点
  pct          REAL NOT NULL,
  -- 当日涨幅最大的非 ST 成分股
  leader_code  TEXT,
  members      INTEGER NOT NULL,
  PRIMARY KEY (date, sector)
);

-- 两张表同一口径版本，重建时整天替换
CREATE TABLE IF NOT EXISTS cross_proxy_built (
  date         TEXT PRIMARY KEY,
  algo_version TEXT NOT NULL,
  built_at     TEXT NOT NULL
);
