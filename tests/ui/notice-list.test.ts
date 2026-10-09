import { describe, expect, it } from "vitest";
import { MAX_KEPT, dedupeMerge, liveCap, olderCursor } from "@/lib/ui/notice-list";

const ns = (from: number, to: number) => {
  const out: { id: number }[] = [];
  for (let id = from; id >= to; id--) out.push({ id });
  return out;
};
const ids = (l: { id: number }[]) => l.map((n) => n.id);

describe("dedupeMerge", () => {
  it("按 id 去重，新→旧", () => {
    expect(ids(dedupeMerge([{ id: 3 }, { id: 1 }], [{ id: 2 }, { id: 3 }], null))).toEqual([3, 2, 1]);
  });

  it("给了 cap 就丢最旧的", () => {
    expect(ids(dedupeMerge(ns(10, 1), [{ id: 11 }], 5))).toEqual([11, 10, 9, 8, 7]);
  });
});

/**
 * 回归：手上已有 MAX_KEPT 条时点"加载更多"。
 * 旧实现合并时一律截到 MAX_KEPT，拉回来的那页立刻被丢，游标不动，同一页反复拉。
 */
describe("超过上限后加载更多", () => {
  it("翻页拉回的旧通知保留，游标前进", () => {
    let list = ns(1000, 1000 - MAX_KEPT + 1);              // 恰好 MAX_KEPT 条：1000..501
    expect(list.length).toBe(MAX_KEPT);
    const c1 = olderCursor(list);
    expect(c1).toBe(501);
    list = dedupeMerge(list, ns(500, 491), null);          // 服务端 before=501 的那页
    expect(list.length).toBe(MAX_KEPT + 10);
    const c2 = olderCursor(list);
    expect(c2).toBe(491);                                  // 游标前进了，下一次拉的是新的一页
    list = dedupeMerge(list, ns(490, 481), null);
    expect(olderCursor(list)).toBe(481);
  });

  it("此后 SSE 推新：不截掉用户已展开的条数", () => {
    const revealed = MAX_KEPT + 20;
    let list = ns(1000, 1000 - revealed + 1);              // 已展开 520 条
    list = dedupeMerge(list, [{ id: 1001 }], liveCap(revealed));
    expect(list.length).toBe(revealed);
    expect(list[0].id).toBe(1001);
  });

  it("没翻过页时 SSE 推新仍按 MAX_KEPT 截", () => {
    expect(liveCap(10)).toBe(MAX_KEPT);
    const list = dedupeMerge(ns(MAX_KEPT, 1), [{ id: MAX_KEPT + 1 }], liveCap(10));
    expect(list.length).toBe(MAX_KEPT);
    expect(list[list.length - 1].id).toBe(2);
  });

  it("空列表的游标是 0 = 拉第一页", () => {
    expect(olderCursor([])).toBe(0);
  });
});
