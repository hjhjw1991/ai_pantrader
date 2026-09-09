-- 预测要记下它是**哪一版参数**产出的。
--
-- 为什么现在必须加：买点规则刚从写死的 min(昨收, MA5) 改成可配的
-- "昨收 × (1 + 相对昨收)"，而这个值明确是要按台账数据反复重调的。
-- 每调一次，之后的推荐就和之前的不是同一件事了 —— 触发率、胜率、盈亏比
-- 三个数全都会变。把两批混在一个分母里算，得到的既不是旧参数的成绩，
-- 也不是新参数的成绩，而是一个谁也解释不了的加权平均。
--
-- strategy_id 单独不够用：id 一直是 "default"，版本号才是区分参数代际的东西。
-- （strategy 表里有 yaml 全文快照，但那是给人回看的；
--   要按版本分组统计，必须在 prediction 这一行上就能筛。）
--
-- 允许 NULL：迁移之前写入的行确实不知道自己是哪一版，
-- 编一个版本号进去就是伪造台账。查询侧把 NULL 当作"版本未知"单独处理。
ALTER TABLE prediction ADD COLUMN strategy_ver TEXT;

-- 复盘按 (策略, 版本) 分组，这是它的主要读法
CREATE INDEX IF NOT EXISTS idx_prediction_strategy_ver ON prediction(strategy_id, strategy_ver);
