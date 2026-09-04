-- 复盘要回答的是三件事，而不是一件：
--   1. 推荐的买点，价格到底到没到（到不了的推荐等于没推荐）
--   2. 到了之后，盈亏比有多高
--   3. 胜率有没有过 60%
--
-- 原来的 outcome 只有 actual_pct 一个数，而且它是**从基准日收盘价**起算的。
-- 那是在量"这只票后来涨没涨"，不是在量"这条推荐准不准" ——
-- 收盘价是一个系统从没说过要买的价。推荐说的是 trigger_px，
-- 拿收盘价记功记过，等于给策略换了一道它没做过的题。
--
-- 所以这里补的列分两组：
--   触发组（triggered / entry_px / entry_date）—— 回答第 1 件事
--   区间极值组（mfe_pct / mae_pct）—— 回答第 2 件事，单条推荐的盈亏比
--
-- 为什么必须有 MFE/MAE 而不是只看终点涨跌幅：
-- 终点价把"一路平推上去"和"先腰斩再拉回来"算成同一个结果，
-- 而这两种走势对应完全不同的止损设置和完全不同的持有体验。
-- 盈亏比要的正是这两个方向各自走了多远。
--
-- 全部可空：老的、以及未触发的 outcome 这些列本来就没有值，
-- 填 0 会让它们混进平均数里，把统计悄悄拉偏。NULL 才是"没有这个数"。
ALTER TABLE outcome ADD COLUMN triggered INTEGER;      -- 1=到过买点 0=没到 NULL=不适用（无 trigger_px）
ALTER TABLE outcome ADD COLUMN entry_px REAL;          -- 实际成交基准价（限价成交，见 lib/ledger/reconcile）
ALTER TABLE outcome ADD COLUMN entry_date TEXT;        -- 到价那天
ALTER TABLE outcome ADD COLUMN mfe_pct REAL;           -- 区间内最大有利偏移（相对 entry_px）
ALTER TABLE outcome ADD COLUMN mae_pct REAL;           -- 区间内最大不利偏移（相对 entry_px，负数）

-- 复盘报告按"触发 / 未触发"分组统计，这是它唯一的读法
CREATE INDEX IF NOT EXISTS idx_outcome_triggered ON outcome(triggered);
