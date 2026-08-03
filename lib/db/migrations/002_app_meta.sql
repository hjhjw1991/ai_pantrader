-- 系统级键值元数据。
-- 首个用途：system_start_date —— 缺口检测的起算点。
-- 没有它的话 selfcheck 会把系统上线前的整段历史都算成缺口
-- （实测首次运行报 1023 天全缺），真实信号被噪音淹没。
CREATE TABLE IF NOT EXISTS app_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT
);
