import type { CockpitItem, ItemGroup } from "@/lib/ui/adapters/cockpit";
import { defaultDir, sortRows, type SortDir, type SortableValue } from "@/lib/ui/sort";

/**
 * 作战台左侧自选列表（候选 / 持仓 / 观察三组）的排序选项。
 *
 * ── 为什么这里是三组各自的选项，而不是一份通用列表 ──
 *
 * 三组能回答的问题不一样：
 *   候选 —— 今天该先盯哪几只（评分、建议仓位、盈亏比、离买点还有多远）
 *   持仓 —— 哪笔今天波动最大、哪笔快碰到止损了（今日涨幅、距止损）
 *   观察 —— 哪几只快到买点了（距触发价）
 *
 * 塞进去一列"这一组里人人都是 null"的维度（比如给持仓组排评分）不是更全，
 * 是更吵：选完发现顺序没变，会以为功能坏了。
 * 所以每组只留**这一组的行真的有值**的维度。
 *
 * ── 为什么这些算式要单独抽出来 ──
 *
 * 「距触发价」这类派生值既要显示在决策卡的价位上，又要拿来做排序。
 * 各写一遍的话，改了一个另一个没改，就变成"卡上写着 -8%，排序按另一个口径"。
 * 这里集中定义，两处共用同一条算式。
 */

/** a 相对 b 的差比（0.05 = a 比 b 高 5%）。任一为空或 b <= 0 就返回 null */
export function rel(a: number | null, b: number | null): number | null {
  return a !== null && b !== null && b > 0 ? a / b - 1 : null;
}

/** select 里代表"不排序，回到引擎给的原顺序"的那一项 */
export const NO_SORT = "";

export interface GroupSortOption {
  key: string;
  /** 菜单里的短名 —— 侧栏只有 300px，长了会撑破表头 */
  label: string;
  /** 鼠标悬停的解释：把"这个数是大好还是小好"说清楚 */
  title?: string;
  value: (it: CockpitItem) => SortableValue;
}

/** 距止损：止损价相对现价的位置。越接近 0 越危险，正数 = 止损已在现价上方（已破） */
const toStop: GroupSortOption["value"] = (it) => rel(it.stopPx, it.price);
/** 距触发：触发价相对现价的位置。越接近 0 越接近买点 */
const toTrigger: GroupSortOption["value"] = (it) => rel(it.triggerPx, it.price);

const CODE: GroupSortOption = { key: "code", label: "代码", title: "按代码升序", value: (it) => it.code };
const PCT: GroupSortOption = {
  key: "pct", label: "今日涨幅", title: "涨得最多的排最前", value: (it) => it.pct,
};
const PRICE: GroupSortOption = {
  key: "price", label: "现价", title: "贵的排最前；本轮没采到价的排最后", value: (it) => it.price,
};
const RR: GroupSortOption = {
  key: "rr", label: "盈亏比", title: "目标空间与计划亏损之比，高的排最前", value: (it) => it.rrRatio,
};

const OPTIONS: Record<ItemGroup, GroupSortOption[]> = {
  候选: [
    { key: "score", label: "评分", title: "引擎给的综合评分，高的排最前", value: (it) => it.score },
    { key: "size", label: "建议仓位", title: "引擎建议的这笔仓位占比，大的排最前", value: (it) => it.size },
    {
      key: "toTrigger", label: "距触发价",
      title: "触发价相对现价的位置：越接近 0 越接近买点，负数 = 现价已在触发价下方（已到价）",
      value: toTrigger,
    },
    RR,
    PCT,
    CODE,
  ],
  持仓: [
    PCT,
    PRICE,
    { key: "toStop", label: "距止损", title: "止损价相对现价的位置：越接近 0 越接近止损，最危险的排最前", value: toStop },
    RR,
    CODE,
  ],
  观察: [
    {
      key: "toTrigger", label: "距触发价",
      title: "触发价相对现价的位置：越接近 0 越接近买点，负数 = 现价已在触发价下方（已到价）",
      value: toTrigger,
    },
    PCT,
    PRICE,
    RR,
    CODE,
  ],
};

/**
 * 一组的排序菜单。第一项恒为「默认顺序」，取消排序的路和排序本身一样显眼 ——
 * 否则看完"最快到买点的几只"之后，只能刷新整页才能回到引擎给的顺序。
 */
export function sortOptionsFor(g: ItemGroup): GroupSortOption[] {
  return OPTIONS[g];
}

export function findSortOption(g: ItemGroup, key: string): GroupSortOption | null {
  return OPTIONS[g].find((o) => o.key === key) ?? null;
}

/**
 * 选了某个维度之后的方向：数值列给降序，文本列（代码）给升序。
 *
 * 复用 sortRows 那一套取值口径 —— defaultDir 取第一个非空值判断类型，
 * 而不是看声明：某一列这一轮全为空时也退化不出错。
 */
export function initialDir(g: ItemGroup, key: string, list: CockpitItem[]): SortDir {
  const opt = findSortOption(g, key);
  return opt ? defaultDir(list, opt.value) : "desc";
}

/** 应用排序。list 为空或 `it` 取不到值时由 sortRows 兜底（无值恒排最后） */
export function applyGroupSort(
  list: CockpitItem[],
  opt: GroupSortOption | null,
  dir: SortDir,
): CockpitItem[] {
  if (!opt) return list;
  return sortRows(list, opt.value, dir);
}
