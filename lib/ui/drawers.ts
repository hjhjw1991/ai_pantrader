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

/**
 * 当前地址落在哪个抽屉里；不在抽屉上就 null。
 *
 * 抽屉槽显示什么，只看这个返回值 —— 而不是看"刚才谁按了关闭"。
 * 认地址的好处是任何关法（右上角按钮、侧边栏数字键、点已打开的项、浏览器后退、
 * 抽屉里的链接跳出去）都自动覆盖；认按钮的话，少写一条就会漏出一个不该在的抽屉。
 *
 * 严格相等：`/positionsExtra` 不算抽屉，`/positions?tab=1` 算（usePathname 不带查询串，
 * 抽屉里切页签不会引起重解析）。别改成 startsWith —— 将来加子路由会整片误判。
 */
export function drawerAt(pathname: string | null | undefined): DrawerSlug | null {
  if (!pathname) return null;
  return DRAWERS.find(d => pathname === `/${d.slug}`)?.slug ?? null;
}

// ─────────────────────────── 抽屉槽的开关状态（DrawerGate 用） ───────────────────────────

/**
 * 抽屉是否已经关掉 = 点过关闭（即时生效的那一下），**或者**地址已经不在任何抽屉里。
 *
 * 后半句是给那些不走 DrawerFrame 关闭按钮的路径兜的：侧边栏的数字键、0 回作战台、
 * 抽屉里的链接、浏览器后退。认地址而不是认哪个组件按下的键，一条规则覆盖所有关法。
 * 拆成纯函数放这里，是为了让测试跑的就是 DrawerGate 真用的那一条，而不是测试里抄一份。
 */
export function drawerClosed(closedFlag: boolean, drawer: DrawerSlug | null): boolean {
  return closedFlag || drawer === null;
}

/**
 * 地址落定后"点过关闭"这面旗怎么变：**只在进入某个抽屉时复位**，其余情况原样保留。
 *
 * 不能写成"路径一变就复位"：push("/") 完成那一刻路径变了，槽里可能正停在 loading.tsx，
 * 一复位就是"关了 → 弹回来显示加载中 → 再关"。/positions → / 不动，/ → /positions 才开盖。
 */
export function closedFlagAfterNav(closedFlag: boolean, drawer: DrawerSlug | null): boolean {
  return drawer ? false : closedFlag;
}
