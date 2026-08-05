-- 通知队列。SSE 推送与桌面通知都从这里读（spec §13：只有关键信号才响）。
--
-- 为什么必须过数据库、不能用进程内事件总线：
-- 采集跑在独立守护进程里（scripts/daemon.ts），网页服务是另一个进程。
-- 内存事件总线在网页进程里收不到采集进程的事件，SSE 会永远静默。
-- 落库让任意进程当生产者、网页当消费者，同时天然带持久化 ——
-- 关掉浏览器再打开，仍能看到刚才漏掉的告警。
--
-- severity 决定要不要弹桌面通知：
--   critical 硬线告警（破止损/破灾难位）—— 必须响
--   warn     档位切换、采集失败 —— 响
--   info     数据刷新、常规采集完成 —— **不响**，只更新界面
-- 把 info 也弹成桌面通知会让人两天后就把通知权限关掉，
-- 那等于把 critical 一起弄哑了。
CREATE TABLE IF NOT EXISTS notification (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  ts        TEXT NOT NULL,
  kind      TEXT NOT NULL,     -- gear_change | hard_line | new_candidate | collect_failed | ...
  severity  TEXT NOT NULL,     -- critical | warn | info
  title     TEXT NOT NULL,
  body      TEXT,
  /** 去重键：同一件事反复触发只留一条（如同一只票同一天的同一条硬线） */
  dedupe_key TEXT,
  read_at   TEXT
);

CREATE INDEX IF NOT EXISTS idx_notification_ts ON notification(ts);
CREATE UNIQUE INDEX IF NOT EXISTS idx_notification_dedupe
  ON notification(dedupe_key) WHERE dedupe_key IS NOT NULL;

-- 信号状态快照，用于检测"关键信号是否变了"。
-- 只存判定所需的最小摘要：档位、候选票集合、告警数。
-- 存整张卡会让每次比对都要反序列化一大坨 JSON，而变化检测只需要这几个字段。
CREATE TABLE IF NOT EXISTS signal_state (
  id          INTEGER PRIMARY KEY CHECK (id = 1),   -- 单行表
  ts          TEXT NOT NULL,
  gear        TEXT,
  candidates  TEXT,      -- 逗号分隔的代码，排序后存，便于直接比较
  alert_count INTEGER NOT NULL DEFAULT 0
);
