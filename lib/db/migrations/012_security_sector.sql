-- 代码 → 东财行业板块 的映射。
--
-- 为什么必须有这张表：库里此前唯一的"股票属于哪个板块"来源是 zt_pool.sector，
-- 而那只覆盖**曾经涨停过**的票（实测 852 只 / 全市场 5,888）。
-- 于是候选池只能从涨停池里选 —— 入场手法是回踩低吸，标的池的人口结构却是打板股。
-- 要让"主线板块里没涨停但形态好的票"和"全市场量价选出来的票"也能过同一道主线筛，
-- 就得先知道任意一只票属于哪个行业。
--
-- security.board 帮不上忙：那是主板/创业板/科创板（交易所板块），不是行业。
--
-- 一只票一个行业：东财的行业板块（m:90+t:2）是一个划分，不重叠，所以 code 做主键。
-- 存 bk 是为了排错时能直接拼出东财的成分股接口 URL。
--
-- ts 记录这一行是什么时候采的。行业归属变动很慢（并购、主业变更才会动），
-- 所以刷新按"整张表多久没更新过"来判，不必每天重采 —— 全量要 100+ 个请求，
-- 而东财每分钟能接受的请求量很有限（实测每 5 分钟采一次板块榜就会把它打到限流）。
CREATE TABLE IF NOT EXISTS security_sector (
  code   TEXT PRIMARY KEY,
  sector TEXT NOT NULL,
  bk     TEXT NOT NULL,
  ts     TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_security_sector_sector ON security_sector(sector);
