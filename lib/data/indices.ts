/**
 * 采集的指数清单。
 *
 * 为什么需要：`盘面强度` 有 30% 权重来自指数分项（默认 `指数代码: "sh000001"`），
 * 但日线采集只拉 `security` 表里的 6 位股票代码，指数序列从来没进过库 ——
 * 于是那一项**一直取不到值、一直退化成中性 0.5**，而且不报错。
 *
 * 每条都实测取到过日线（新浪 scale=240）。选这六条的理由是各有明确用途且互不重复；
 * 上证50 / 中小100 / 中小板综 / 中证500 与其中几条重叠度高，先不采 ——
 * 多采只是多几条序列，但清单越长越没人知道每条是干嘛的。
 *
 * 指数代码不遵循"6 开头即沪市"的规则（上证指数是 sh000001，而 sz000001 是平安银行），
 * 所以一律存**带前缀的 symbol**，采集也走 fetchSinaKlineBySymbol。
 */
export interface IndexDef {
  /** 新浪 symbol，同时也是写进 kline_daily 的 code */
  symbol: string;
  name: string;
  why: string;
}

export const INDICES: IndexDef[] = [
  { symbol: "sh000001", name: "上证指数", why: "策略默认的指数分项就是它（盘面强度 30% 权重）" },
  { symbol: "sh000300", name: "沪深300", why: "权重股口径 —— 防守触发里的『权重杀跌』缺的就是这个" },
  { symbol: "sh000852", name: "中证1000", why: "小盘，最贴近实际交易的标的；与沪深300 的背离本身是风格信号" },
  { symbol: "sz399006", name: "创业板指", why: "创业板权限对应的成长/情绪口径" },
  { symbol: "sh000688", name: "科创50", why: "科创板权限；半导体全链主战场" },
  { symbol: "sz399001", name: "深证成指", why: "深市整体" },
];

/** 某个 code 是不是我们采的指数。用于把指数与个股分开统计 */
export function isIndexSymbol(code: string): boolean {
  return INDICES.some(i => i.symbol === code);
}
