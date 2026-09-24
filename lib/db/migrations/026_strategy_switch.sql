-- 策略切换记录：影子盘里的挑战者毕业、换成正式策略的每一次，以及每一次回滚。
--
-- 切换本身落在策略 YAML 的 `槽位:` 段（D7：YAML 是唯一真相源），这张表只记"谁、何时、凭什么"。
-- 没有这张表，一次切换之后就再也说不清：正式策略为什么从这天起换了打法、
-- 当时的证据是什么、是人批的还是自动切的、要回滚该回到哪一版。
--
-- 只追加、不删：pending 只会走向 applied / rejected / stale，回滚是新插一行（kind = rollback），
-- 不改被回滚的那一行 —— 否则"切过、又退回"这段历史会被抹成"从没切过"。
CREATE TABLE IF NOT EXISTS strategy_switch (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  -- switch = 挑战者上位；rollback = 撤销上一次切换
  kind         TEXT NOT NULL,
  -- pending（待批）/ applied（已生效）/ rejected（人否了）/ stale（等批期间证据不再成立或文件被手改）
  status       TEXT NOT NULL,
  strategy_id  TEXT NOT NULL,
  from_variant TEXT,
  to_variant   TEXT,
  -- SlotConfig 的 canonical JSON。{} = baseline 组合（YAML 里没有 `槽位:` 段）
  from_slots   TEXT NOT NULL,
  to_slots     TEXT NOT NULL,
  from_version TEXT,
  to_version   TEXT,
  -- 毕业判定当时的成绩单（样本数、期望差、t、回撤），给人批的时候看
  evidence     TEXT,
  -- human / auto。pending 与 stale 时为 NULL
  decided_by   TEXT,
  -- rollback 行指向它撤销的那次 switch
  reverts      INTEGER REFERENCES strategy_switch(id),
  note         TEXT,
  proposed_at  TEXT NOT NULL,
  decided_at   TEXT
);

CREATE INDEX IF NOT EXISTS idx_strategy_switch_status ON strategy_switch(status);
