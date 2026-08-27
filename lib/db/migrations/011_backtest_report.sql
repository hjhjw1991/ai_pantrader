-- 回测/参数扫描的报告存档。
--
-- 为什么要落库：报告原本只活在 React state 里，离开页面就没了。
-- 而生成它的代价不小 —— 实测 0.38 秒/交易日，四年跨度的单次回测约 6 分钟，
-- 36 点的参数扫描约 3.7 小时。让人为了再看一眼上周那次结果而重跑三个半小时，
-- 是这套系统里最贵的一次"没存"。
--
-- 存整份 JSON 而不是拆成关系表：报告是**不可变的快照**，
-- 它的价值恰恰在于"当时那份配置、那段区间、那套约束算出来就是这个数"。
-- 拆表之后每次 schema 演进都要考虑怎么迁移历史报告，而迁移过的报告
-- 已经不是当时那份了 —— 那正是存档要避免的事。
-- 体积也不构成理由：实测一年跨度 13 KB，四年约 50 KB。
--
-- kind 分开存回测与扫描：两者的 JSON 结构不同（BacktestReport / SweepReport），
-- 读的时候必须先知道该按哪个契约解析，不能靠猜。
CREATE TABLE IF NOT EXISTS backtest_report (
  id            TEXT PRIMARY KEY,      -- 生成时刻 + 随机后缀，稳定且可排序
  ts            TEXT NOT NULL,         -- 生成时间，上海挂钟（全库口径，见 migration 006）
  kind          TEXT NOT NULL,         -- backtest | sweep
  strategy_id   TEXT NOT NULL,
  strategy_ver  TEXT NOT NULL,
  from_date     TEXT NOT NULL,
  to_date       TEXT NOT NULL,
  initial_cash  REAL NOT NULL,
  -- 列表页要显示的几个数，单独拎出来：列一页存档不该把几十份 JSON 全读进内存
  annual_return REAL,
  max_drawdown  REAL,
  calmar        REAL,
  trades        INTEGER,
  -- 扫描独有：扫了几个点。回测为 NULL
  evaluated     INTEGER,
  report_json   TEXT NOT NULL
);

-- 列表按时间倒序取最近 N 条，这是唯一的读法
CREATE INDEX IF NOT EXISTS idx_backtest_report_ts ON backtest_report(ts DESC);
