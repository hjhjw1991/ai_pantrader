/**
 * 抽屉清单。作战台是唯一主页，其余功能都是从右侧滑出的抽屉，每个抽屉是一个路由。
 * 只留五个：相近的合在一个抽屉里分页签（持仓 + 观察池、台账 + 回测），侧边栏不堆一长串入口。
 * 纯数据、不引服务端模块：侧边栏（客户端组件）也读它。
 */
export const DRAWERS = [
  { slug: "positions", title: "我的股票", key: "1", icon: "briefcase", hint: "持仓、成交回填、账户；观察池" },
  { slug: "shadow", title: "影子盘", key: "2", icon: "layers", hint: "几套组合并行出信号、各自结算；赢过正式组合才换上去" },
  { slug: "market", title: "盘面", key: "3", icon: "bars", hint: "涨停池、连板梯队、板块涨幅、龙虎榜" },
  { slug: "ledger", title: "复盘与回测", key: "4", icon: "flask", hint: "预测台账、胜率闭环；回测与参数扫描" },
  { slug: "settings", title: "设置", key: "5", icon: "gear", hint: "策略参数、账户、数据源健康与缺口、备份" },
] as const;

export type DrawerSlug = (typeof DRAWERS)[number]["slug"];
export type DrawerIcon = (typeof DRAWERS)[number]["icon"];
export const drawerOf = (slug: string) => DRAWERS.find(d => d.slug === slug) ?? null;
