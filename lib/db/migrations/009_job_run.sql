-- 调度执行台账。
--
-- 调度从"平台的事"变成"源码里的事"（lib/data/scheduler.ts），随仓库走、跨平台。
-- 但进程内调度带来两个必须解决的问题，都靠这张表解决：
--
-- 1. 去重。同一台机器上可能同时存在 launchd agent（macOS 已装的）和进程内调度，
--    甚至开着两个终端各跑一个。没有共享台账，全市场快照会被重复采集
--    （5888 只 × 多份请求），既浪费限频额度又可能把源打挂。
--    主键 (date, job, slot) 让"某天某时点的某个 job"只可能执行一次，
--    谁先抢到谁执行，另一方看到已有记录直接跳过。
--
-- 2. 补跑判定。用户中午才启动系统时，得知道上午哪些时点没跑过 ——
--    这正是"只要运行过这个系统就会自动唤起采集"要的信息。
--
-- status 的三态是刻意的：
--   done   已执行完
--   failed 执行过但失败（错误留在 error 里，交给缺口流程）
--   missed 时点已过但从未执行（机器当时没开/没跑）。
--          **不标成 done** —— 不可回补的快照缺了就是缺了，
--          把没跑过的时点记成成功等于伪造覆盖率。
CREATE TABLE IF NOT EXISTS job_run (
  date        TEXT NOT NULL,      -- 交易日（Asia/Shanghai）
  job         TEXT NOT NULL,
  slot        TEXT NOT NULL,      -- 计划时点 HH:MM（Asia/Shanghai），补跑记原计划时点
  status      TEXT NOT NULL,      -- done | failed | missed
  started_at  TEXT,
  finished_at TEXT,
  /** 触发者：scheduler（进程内）/ launchd / manual，用于排查重复与漏跑 */
  runner      TEXT,
  stats_json  TEXT,
  error       TEXT,
  PRIMARY KEY (date, job, slot)
);

CREATE INDEX IF NOT EXISTS idx_job_run_date ON job_run(date, status);
CREATE INDEX IF NOT EXISTS idx_job_run_job ON job_run(job, date);
