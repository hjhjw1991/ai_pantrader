-- 申万行业快照。
--
-- 为什么存「快照」而不是一张 (code → 行业) 的当前表：
--
-- 申万把历史变更轨迹的对外渠道停掉了 —— 官网带「结束日期」的 SwClass.xls
-- 是 2022-03-25 的冻结文件且该列 4701 行全空，行业调整公告停在 2021-11-23。
-- 但成分接口本身是活的（实测电子行业最新一条计入日期 2026-09-11）。
-- 也就是说：**当前归属查得到，谁什么时候从哪挪到哪查不到。**
--
-- 而回测需要的恰恰是后者。拿今天的行业表去回刷历史，是教科书级的未来函数，
-- 且偏向"事后被划进景气行业的票"——正好会系统性抬高行业轮动策略的回测收益，
-- 而行业轮动正是这套系统要用来选主线的东西。
--
-- 唯一无偏的办法是自己按周存档，再靠相邻两张快照做差分把退出日期推出来：
-- 某票在快照 N 属于行业 A、在快照 N+1 属于行业 B，就能把 A 的区间封口。
-- 代价是退出日期最多滞后一个快照周期（周频 ≤7 天），方向是"行业切换识别得晚",
-- 属于信号钝化，不产生未来函数。
--
-- 这张表因此是只追加的时间序列，越早开跑越值钱 —— 它攒的是别处买不到的东西。
--
-- level 只有 1 和 3：二级没有可靠的代码规则（名字带 Ⅱ 的只有 45 个而二级有 131 个），
-- 靠猜会把风格指数混进来。三级颗粒度比二级更细，主线判定够用。
CREATE TABLE IF NOT EXISTS sw_industry_snapshot (
  snapshot_date  TEXT NOT NULL,
  code           TEXT NOT NULL,
  level          INTEGER NOT NULL,
  index_code     TEXT NOT NULL,
  index_name     TEXT NOT NULL,
  weight         REAL,
  -- 申万给的计入日期。新股等于上市日；老股出现新日期表示被重分类。
  -- 它是差分推退出日期时的锚点，别丢。
  beginning_date TEXT,
  PRIMARY KEY (snapshot_date, code, level)
);

-- 查"这只票历次快照里的行业"，差分时的主路径
CREATE INDEX IF NOT EXISTS idx_sw_snap_code ON sw_industry_snapshot(code, level, snapshot_date);
-- 查"某个行业某次快照的成分"
CREATE INDEX IF NOT EXISTS idx_sw_snap_index ON sw_industry_snapshot(index_code, snapshot_date);
