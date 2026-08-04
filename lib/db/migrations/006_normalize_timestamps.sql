-- 时间戳口径统一为上海挂钟 `YYYY-MM-DD HH:MM:SS`（见 lib/data/clock.ts）。
--
-- 历史数据里 quote_snapshot / source_health / data_gap / app_meta 写的是
-- `new Date().toISOString()`（`2026-08-03T06:47:41.774Z`），而分钟线和板块榜写的是
-- 数据源给的上海挂钟时间。两种格式混在同一套 `WHERE ts <= ?` 里，
-- 问题不是"差 8 小时"，而是字符串比较下 `T`(0x54) 恒大于空格(0x20) ——
-- 带 T 的行永远排在后面，与真实时间无关，防未来函数的时点约束会被直接击穿。
--
-- 只转还带 `T` 的行（LIKE '%T%'），所以本迁移可重复执行不会二次加 8 小时。
--
-- 用 strftime %f 而不是 datetime()：datetime() 会截掉毫秒，而 source_health 的主键是
-- (source, ts)，一秒内的多条健康记录会因此撞主键。第一版就是这么炸的。

UPDATE quote_snapshot
   SET ts = strftime('%Y-%m-%d %H:%M:%f', ts, '+8 hours')
 WHERE ts LIKE '%T%';

UPDATE source_health
   SET ts = strftime('%Y-%m-%d %H:%M:%f', ts, '+8 hours')
 WHERE ts LIKE '%T%';

UPDATE data_gap
   SET detected_at = strftime('%Y-%m-%d %H:%M:%f', detected_at, '+8 hours')
 WHERE detected_at LIKE '%T%';

UPDATE data_gap
   SET resolved_at = strftime('%Y-%m-%d %H:%M:%f', resolved_at, '+8 hours')
 WHERE resolved_at LIKE '%T%';

UPDATE app_meta
   SET updated_at = strftime('%Y-%m-%d %H:%M:%f', updated_at, '+8 hours')
 WHERE updated_at LIKE '%T%';
