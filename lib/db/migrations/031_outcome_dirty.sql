-- 031: outcome 加 dirty_reason，隔离复权/停牌跳变污染胜率与盈亏比（2026-10-21 修复）
--
-- 复权脏数据（典型如某票 5 日涨 1000%+）会让 actual_pct 严重失真。reconcile 早就能
-- 识别（与龙虎榜 dX_chg 标签背离即「通常意味着复权/停牌」），但此前只「报出来让人看，
-- 不自动改判」，于是脏 actual_pct 直接进了胜率/盈亏比统计，把胜率从 50% 撑到 82%、把
-- 盈亏比从 <1 撑到 152。加这列标记脏数据，统计层（winrate/review/dashboard）排除之。
--
-- 只加一列，不动既有行：脏数据由 reconcile 的 markDirtySettled 在下次对账时幂等回填。
ALTER TABLE outcome ADD COLUMN dirty_reason TEXT;
