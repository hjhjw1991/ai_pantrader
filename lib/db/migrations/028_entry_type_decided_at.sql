-- 结算口径两处修正（用户 2026-10-09 选定）：
--
-- 1. 决策时刻（decided_at）
--    影子盘结算按"成交日开盘 / 最低价"撮合，隐含前提是单子在成交日 09:25 集合竞价撮合**之前**
--    就挂上了。机器晚醒时 09:15 的盘前计划会补跑到 11:00，结算却照样拿那天整天的开盘与低点算 ——
--    开盘前已经发生的成交被记到了它头上。这种样本作废（shadow_outcome.status = '作废'、
--    outcome.verdict = '作废'），不进胜率、毕业与报表，只在列表里留痕。
--
--    判据要的是"引擎算这张卡时的视图时点"（runShadowDay 的 asOf），不是 created_at：
--    回放样本的 created_at 是回放那天的挂钟（几个月后），拿它判会把全部回放样本判成作废。
--    之前没存这一列，老行按来源补：
--      replay → 基准日 15:05:00（runDayResilient 写死的视图时点）
--      live   → created_at（与 asOf 只差引擎算卡的那几秒，且只会偏晚，不会把晚的判成早的）
--
--    台账（prediction）不用加：它的 ts 就是 card.ts，本来就是决策时刻。
--
-- 2. 进场方式（entry_type）：低吸 = 买入限价单，突破 = 买入触价单（口径见 lib/contracts/strategy.ts EntryType）。
--    老行一律补 '低吸' —— 那是它们当时实际被结算的口径。打板 / 半路的老样本其实该按突破撮合，
--    但哪条出自哪个手法没有落表，猜不出来；它们留在各自的旧槽版本（slot_lock）下，不与新样本混算。
--
-- 状态取值（无 CHECK，这里记全）：
--   shadow_outcome.status ∈ 已结算 / 未触发 / 作废
--   outcome.verdict       ∈ 命中 / 偏差 / 中性 / 未触发 / 作废
--
-- 已经结算过的晚决策老行：不在这里改。结算侧（settleShadowPending / reconcile）每次开跑先扫一遍
-- "决策晚于成交日 09:25 而还没作废的"，原地改成作废 —— 判据只在 TS 里写一份（lib/data/clock.ts
-- isLateDecision），夜里那一轮跑过就修好了历史，以后也兜住任何漏网的行。

ALTER TABLE shadow_pred ADD COLUMN decided_at TEXT;
UPDATE shadow_pred
   SET decided_at = CASE WHEN source = 'replay' THEN base_date || ' 15:05:00' ELSE created_at END
 WHERE decided_at IS NULL;

ALTER TABLE shadow_pred ADD COLUMN entry_type TEXT NOT NULL DEFAULT '低吸'
  CHECK (entry_type IN ('低吸', '突破'));
ALTER TABLE prediction ADD COLUMN entry_type TEXT NOT NULL DEFAULT '低吸'
  CHECK (entry_type IN ('低吸', '突破'));
