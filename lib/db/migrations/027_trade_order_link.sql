-- 成交关联到下单单（ord）。manual 模式下"系统出单 → 人在券商 App 手敲 → 回填成交"，
-- 回填时要知道是哪张单成交了、成交了多少，才能把单子标成 filled / partial。
-- 旧成交与不经下单单直接回填的成交为 NULL。
ALTER TABLE trade ADD COLUMN order_id TEXT;
CREATE INDEX IF NOT EXISTS idx_trade_order ON trade(order_id);
