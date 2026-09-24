/**
 * 抽屉清单。作战台是唯一主页，其余功能都是从右侧滑出的抽屉，每个抽屉是一个路由。
 * 纯数据、不引服务端模块：导航栏（客户端组件）也读它。
 */
export const DRAWERS = [
  { slug: "positions", title: "持仓管理", key: "1", hint: "账户分开、浮盈亏、止损止盈线、回填成交" },
  { slug: "watchpool", title: "观察池", key: "2", hint: "人工录入的清单：买入条件、触发价、止损" },
  { slug: "shadow", title: "影子盘", key: "3", hint: "几套组合并行出信号、各自结算；赢过正式组合才换上去" },
  { slug: "market", title: "盘面原料", key: "4", hint: "涨停池、连板梯队、板块涨幅、龙虎榜" },
  { slug: "ledger", title: "台账 / 胜率", key: "5", hint: "预测、结算与胜率闭环" },
  { slug: "lab", title: "回测实验室", key: "6", hint: "回测与参数扫描" },
  { slug: "settings", title: "设置", key: "7", hint: "策略参数、账户、数据源与备份" },
] as const;

export type DrawerSlug = (typeof DRAWERS)[number]["slug"];
export const drawerOf = (slug: string) => DRAWERS.find(d => d.slug === slug) ?? null;
