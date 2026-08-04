-- advisor_output 的主键 (ts, code, slot) 装不下 A/B 对照。
--
-- spec §5.3 要量化 Claude 的边际贡献，做法是同一份输入跑两次（有 Advisor / 无 Advisor，
-- 或两版提示词）再比 Calmar 差值。两次运行的 ts 相同 —— 回放同一时点本来就该相同 ——
-- 于是第二次的行按主键覆盖掉第一次的，实验组和对照组只可能剩一组。
--
-- 讽刺的是读侧本来是对的：loadSnapshots 早就按
-- (ts, mode, prompt_hash, input_snapshot_hash) 归组，只是写侧永远造不出第二组给它归。
--
-- run_id 标识"一次 Advisor 调用"。默认由 (mode, promptHash, inputSnapshotHash) 派生，
-- 是确定性的 —— 不用时钟也不用随机数，否则同一份历史输入回放两次会产生不同的 run_id，
-- 直接违反 spec §17 断言 4（同输入两次回测结果哈希一致）。
--
-- SQLite 不能 ALTER 主键，只能重建。历史行补 run_id = 'legacy'，
-- 它们本来就只有一组，不存在需要区分的对照。

CREATE TABLE advisor_output_new (
  run_id      TEXT NOT NULL,
  ts          TEXT NOT NULL,
  code        TEXT NOT NULL DEFAULT '',
  slot        TEXT NOT NULL,
  value       TEXT,
  mode        TEXT NOT NULL,
  model       TEXT,
  prompt_hash TEXT NOT NULL,
  input_snapshot_hash TEXT NOT NULL,
  confidence  REAL,
  degraded    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (run_id, ts, code, slot)
);

INSERT INTO advisor_output_new
  (run_id, ts, code, slot, value, mode, model, prompt_hash, input_snapshot_hash, confidence, degraded)
SELECT 'legacy', ts, code, slot, value, mode, model, prompt_hash, input_snapshot_hash, confidence, degraded
  FROM advisor_output;

DROP TABLE advisor_output;
ALTER TABLE advisor_output_new RENAME TO advisor_output;

-- A/B 统计按 (ts, run_id) 拉数据，按 mode 分组
CREATE INDEX IF NOT EXISTS idx_advisor_ts ON advisor_output(ts);
CREATE INDEX IF NOT EXISTS idx_advisor_run ON advisor_output(run_id);
CREATE INDEX IF NOT EXISTS idx_advisor_mode ON advisor_output(mode, ts);
