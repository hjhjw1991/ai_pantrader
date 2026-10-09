/**
 * 铃铛通知列表的合并规则（纯函数，不含 React —— 客户端组件和测试都能用）。
 *
 * 抽出来是因为"会话内保留上限"和"加载更多"曾经互相打架：
 * 列表超过上限之后，用户点"加载更多"拉回来的那一页更旧的通知，
 * 合并时立刻又被上限截掉 —— 列表没变长，翻页游标（取列表最后一条的 id）也就不动，
 * 下一次点还是拉同一页，"还有 N 条"只因为 revealed 涨了而一路往下减，实际什么都没多出来。
 */

export type NoticeLike = { id: number };

/**
 * 会话内保留上限。
 *
 * SSE 一路往里塞，两天不关页面就能攒出上千条，而人根本不会翻到那么远。
 * 超过的部分丢最旧的（它们随时能从 /api/notifications 重新拉回来，不丢数据）。
 * **只约束 SSE 推来的新通知** —— 人主动翻出来的旧通知不受它管，见 liveCap。
 */
export const MAX_KEPT = 500;

/**
 * 按 id 去重合并，保持新→旧；cap 为 null 时不截断。
 *
 * SSE 推来的和历史翻页拉回来的会在中间地带撞车（同一条通知两边都到），
 * 直接 concat 会让同一个 id 出现两次，而 React 的 key 重复是运行时警告级别的脏数据。
 */
export function dedupeMerge<T extends NoticeLike>(
  prev: T[],
  incoming: T[],
  cap: number | null
): T[] {
  const byId = new Map<number, T>();
  for (const n of prev) byId.set(n.id, n);
  for (const n of incoming) byId.set(n.id, n);   // 后来的覆盖：服务端口径是准的
  const all = [...byId.values()].sort((a, b) => b.id - a.id);
  return cap === null ? all : all.slice(0, cap);
}

/**
 * SSE 推新通知时的截断上限：至少 MAX_KEPT，且不少于用户已经展开看到的条数。
 *
 * 翻页拉回来的旧通知合并时不截（cap = null）—— 那是人点了"加载更多"要看的，
 * 截掉它们就是上面说的死循环。而推新通知时若按死 MAX_KEPT 截，
 * 已经翻到第 600 条的人会眼看着底下 100 条消失，所以取两者较大值。
 */
export function liveCap(revealed: number): number {
  return Math.max(MAX_KEPT, revealed);
}

/** 下一页"更旧通知"的游标：手上最旧那条的 id；还没有任何通知时 0 = 拉第一页 */
export function olderCursor(list: NoticeLike[]): number {
  return list.length === 0 ? 0 : list[list.length - 1].id;
}
