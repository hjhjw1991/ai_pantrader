-- 影子盘：多套槽位组合（变体）与正式策略并行出信号、各自结算，比出高下。
--
-- 与 prediction / outcome 分表，不共用：
--   1. 结算口径不同。正式台账是"持有 5 天看收盘"，影子盘按止损 / 目标价模拟离场
--      （用户 2026-09-23 选定）—— 混在一张表里，同一个 verdict 列会有两种含义
--   2. 正式台账一天只记一批（alreadyRecordedToday），影子盘一天记 N 批
--   3. 影子盘有回放样本（source = replay），它们只用于冷启动排序，不计入毕业；
--      混进正式台账会让周复盘的胜率被历史回放稀释
--
-- 两张记录表都**只追加**：同一 id 重复写是 no-op，结算一旦落定不再改。

CREATE TABLE IF NOT EXISTS shadow_variant (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  -- v2 的槽位选择（SlotConfig），JSON。空对象 = baseline 组合
  slot_config TEXT NOT NULL,
  note        TEXT,
  -- active / retired。毕业不是一种状态：毕业 = 它被切成了正式策略，切换记录另表存（④期3）
  status      TEXT NOT NULL DEFAULT 'active',
  created_at  TEXT NOT NULL,
  retired_at  TEXT
);

CREATE TABLE IF NOT EXISTS shadow_pred (
  id           TEXT PRIMARY KEY,
  variant_id   TEXT NOT NULL,
  -- live = 每天 09:15 随盘前计划跑出来的；replay = 历史回放补的冷启动样本
  source       TEXT NOT NULL,
  -- 基准日：做判断时能看到的最后一个收盘日。成交看它的下一个交易日
  base_date    TEXT NOT NULL,
  -- 发出日（live 是计划当天；replay 与 base_date 相同）
  decided_on   TEXT NOT NULL,
  code         TEXT NOT NULL,
  name         TEXT,
  account      TEXT NOT NULL,
  trigger_px   REAL NOT NULL,
  stop_px      REAL,
  target_px    REAL,
  rr_ratio     REAL,
  size         REAL NOT NULL,
  score        REAL,
  gear         TEXT NOT NULL,
  -- 五段状态机判出的阶段；择时器不判阶段时为 NULL（不是"没有阶段"，是"没判"）
  stage        TEXT,
  strategy_id  TEXT NOT NULL,
  strategy_ver TEXT,
  -- 当时各槽实现的版本（SlotRegistry.lock()），样本按它归因：槽改了版本，旧样本不该算到新实现头上
  slot_lock    TEXT NOT NULL,
  created_at   TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_shadow_pred_variant ON shadow_pred(variant_id, source, base_date);

CREATE TABLE IF NOT EXISTS shadow_outcome (
  pred_id     TEXT PRIMARY KEY REFERENCES shadow_pred(id),
  -- 已结算 / 未触发。"待定"不落表，下一晚重试
  status      TEXT NOT NULL,
  entry_date  TEXT,
  entry_px    REAL,
  exit_date   TEXT,
  exit_px     REAL,
  -- 止损 / 目标 / 期满
  exit_reason TEXT,
  gross_pct   REAL,
  net_pct     REAL,
  mfe_pct     REAL,
  mae_pct     REAL,
  note        TEXT,
  settled_at  TEXT NOT NULL
);
