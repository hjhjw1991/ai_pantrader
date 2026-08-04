-- security 的上市/退市/ST 元数据一直是空的：实测 5888 行里 list_date 全为 NULL，
-- delist_date 全为 NULL，is_st_history_json 全为 NULL。bootstrap 只写了 code/name/board。
--
-- 后果不是"少个字段"，而是两条已经写好的逻辑在静默失效：
--   1. spec §10.2 的幸存者偏差过滤（universe 按当日在市筛选）恒为空操作 ——
--      用当前在市清单回测 2022 年等于假装当年买的没一只退市，收益系统性高估。
--   2. 涨停代理的 ST 分支（5% 阈值）与上市首日排除全是死代码。
--
-- 东财 clist 当前 6 个分片全部限流（空响应体），所以先把不依赖网络、
-- 能从已有 567 万根日线里严格推出来的部分落库。

-- 该票在本地日线里的第一根 bar 日期。
-- 注意：这不等于上市日。新浪 datalen 上限 1023 根，长期停牌的票 1023 根能回溯到 1993 年，
-- 所以"窗口起点"不是一个统一的日历日，不能按日期判断是否被截断。
ALTER TABLE security ADD COLUMN first_bar_date TEXT;

-- 本地日线根数。判断 first_bar_date 是真上市日还是仅下界，靠的是这个数而不是日期：
--   n < 1023  → 取满了整条序列，first_bar_date 就是上市日（实测 N聚仁 仅 1 根 = 当日上市）
--   n >= 1023 → 被 datalen 截断，真实上市日早于或等于 first_bar_date，只能当下界
ALTER TABLE security ADD COLUMN bar_count INTEGER;

-- list_date 的口径由此明确：只在能严格确定时才填，填不了就保持 NULL。
-- 消费方（universe 的在市判断）必须区分"NULL = 上市于数据窗口之前"和"有值 = 确切上市日"，
-- 不许把 NULL 当成"未上市"，那会把 4951 只老票全部排除掉。
