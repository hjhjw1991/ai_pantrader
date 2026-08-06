-- 账户由用户定义，不是程序里的枚举。
--
-- 原先 AccountType 是两个内置账户名的联合类型，account 表的注释也写着那两个名字：
-- 加一个账户、改一个名字都要改代码重新编译。账户是用户组织自己资金的方式，
-- 程序无权预设。清单归数据（本表），每账户规则归 strategy.yaml 的持仓段（D7）。
--
-- 本迁移不预置任何账户：默认零行，由用户在设置页新建。
-- 预置几个账户再让用户删，等于把开发者的假设塞进用户的账本。

-- 软删除：账户删了但历史 position/trade 还引用它，硬删会让台账丢归属
ALTER TABLE account ADD COLUMN active INTEGER NOT NULL DEFAULT 1;
ALTER TABLE account ADD COLUMN note TEXT;
ALTER TABLE account ADD COLUMN created_at TEXT;

CREATE INDEX IF NOT EXISTS idx_account_active ON account(active);
