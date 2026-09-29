/**
 * 表头排序的取值逻辑（不含 React，服务端/客户端/测试都能用）。
 *
 * 抽出来而不写进组件里，是因为这里面有一条会**静默骗人**的规则
 * （无值一律排最后），它值得有单元测试盯着。
 */

/** 排序取值的结果类型。null = 这一行在这个维度上没有值 */
export type SortableValue = number | string | null;

export type SortDir = "asc" | "desc";

/**
 * 把 rows 按 value(row) 排一遍。
 *
 * ── 无值一律排最后，不按 0 处理 ──
 *
 * 这是本函数唯一真正的业务判断，也是最重要的一条。
 * 没有快照就拿不到现价，也就算不出市值；如果把它当成 0，
 * 升序时它会排在最前面 —— 读起来像"这是最小的一笔仓，可以随手清掉"，
 * 而实际上它可能是当天市值最大的那个仓位，只是这一轮没采到价。
 *
 * 反过来更糟：观察池按现价升序时，一排"—"压在最上面，
 * 看着像一堆跌到 0 的票。两头都不成立，所以**恒排最后**（升降序都一样）——
 * 否则按市值降序时，算不出市值的那几只会被顶到你眼前。
 *
 * ── 相等时保留原顺序 ──
 *
 * 同为 null、或数值相等的两行按原始相对次序输出（显式带上 index 做最后比较键，
 * 不依赖引擎的 sort 稳定性）。软刷新带来一批新价时，这能让没动的那几行
 * 保持在原来位置，不会整表乱跳。
 */
export function sortRows<T>(
  rows: T[],
  value: (r: T) => SortableValue,
  dir: SortDir
): T[] {
  const sign = dir === "asc" ? 1 : -1;
  return rows
    .map((row, i) => ({ row, i, v: value(row) }))
    .sort((a, b) => {
      if (a.v === null || b.v === null) {
        if (a.v === b.v) return a.i - b.i;   // 两个都无值：退回原顺序
        return a.v === null ? 1 : -1;        // 有值的永远在前
      }
      const c =
        typeof a.v === "number" && typeof b.v === "number"
          ? a.v - b.v
          : String(a.v).localeCompare(String(b.v), "zh-Hans-CN");
      return c !== 0 ? c * sign : a.i - b.i;
    })
    .map((x) => x.row);
}

/**
 * 一列首次被点击时用哪个方向。
 *
 * 数值列给降序：看市值、看现价、看浮盈亏，人想先看到的都是"最大的那个"。
 * 文本列（代码、名称、账户）给升序：从大到小读一串中文名没有意义。
 *
 * 取**第一个非空值**来判断，而不是传一个样例值进来 ——
 * 调用方手上的样例往往取自第 0 行，而第 0 行恰好是 null 的情况太常见了
 * （排第一位的那只往往就是没采到价的）。
 */
export function defaultDir<T>(rows: T[], value: (r: T) => SortableValue): SortDir {
  for (const r of rows) {
    const v = value(r);
    if (typeof v === "number") return "desc";
    if (typeof v === "string") return "asc";
  }
  return "desc";   // 整列都无值：给个默认值，方向无所谓
}

export type SortState<T = unknown> = { key: string; dir: SortDir };

/**
 * 点一次表头之后的下一个状态。三态循环：
 *
 *     默认方向 → 反向 → 取消（回到原始顺序）→ 默认方向 → …
 *
 * 第三态是必要的：看完"市值最大的几只"之后要有路回到按代码的默认顺序，
 * 否则只能刷新整页。而原始顺序本身有意义 —— 它是 SQL 里的
 * `ORDER BY account_id, code`，稳定的、能对账的顺序。
 */
export function nextSortState<T>(
  prev: SortState<T> | null,
  key: string,
  rows: T[],
  value: (r: T) => SortableValue
): SortState<T> | null {
  const first = defaultDir(rows, value);
  if (prev === null || prev.key !== key) return { key, dir: first };
  // 已经在默认方向 → 翻到反向；已经翻过 → 取消
  return prev.dir === first ? { key, dir: first === "asc" ? "desc" : "asc" } : null;
}
