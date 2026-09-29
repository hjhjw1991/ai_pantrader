import { describe, expect, it } from "vitest";
import { DRAWERS, drawerAt, drawerOf } from "@/lib/ui/drawers";

/**
 * 抽屉路由的判定。
 *
 * 这里盯的是一条曾经被写坏过的规则：**抽屉槽该不该显示，取决于地址落在不在某个抽屉里**。
 * 写成"pathname 一变就复位"、或改用 startsWith 匹配，都会把一次关闭变成
 * "关了 → 弹回来显示加载中 → 再关"这种看得见的坏相。所以给它几条断言。
 */

describe("drawerAt", () => {
  it("落在五个抽屉路由上时认出来", () => {
    for (const d of DRAWERS) expect(drawerAt(`/${d.slug}`)).toBe(d.slug);
  });

  it("作战台与非抽屉路径 → null", () => {
    expect(drawerAt("/")).toBeNull();
    expect(drawerAt("/today")).toBeNull();
    expect(drawerAt("/lab")).toBeNull();
  });

  /** 严格相等，不是前缀匹配 —— 将来加 /positions/history 这类子路由不会被误判成抽屉本身 */
  it("不能是前缀匹配：多出来的一段不算抽屉", () => {
    expect(drawerAt("/positionsExtra")).toBeNull();
    expect(drawerAt("/positions/history")).toBeNull();
    expect(drawerAt("/settings2")).toBeNull();
  });

  it("空值安全（SSR 首帧、路由还没就绪）", () => {
    expect(drawerAt(null)).toBeNull();
    expect(drawerAt(undefined)).toBeNull();
    expect(drawerAt("")).toBeNull();
  });
});

describe("drawerOf", () => {
  it("按 slug 取定义，取不到给 null", () => {
    expect(drawerOf("positions")?.title).toBe("我的股票");
    expect(drawerOf("不存在的")).toBeNull();
  });
});

/**
 * 关闭后的显示规则：`closed = 点过关闭 || 不在抽屉路由`。
 *
 * 后半条是关键：某一台 DrawerFrame 实例是不是该收起来，看的是**地址**，
 * 不是"这个实例自己有没有被点过关闭" —— 因为导航过程中 @drawer 槽会换成
 * loading.tsx 里另一台 DrawerFrame，那台没被点过。
 */
describe("抽屉是否可见", () => {
  const visible = (closedFlag: boolean, pathname: string) => !closedFlag && drawerAt(pathname) !== null;

  it("打开中：看得见", () => {
    expect(visible(false, "/positions")).toBe(true);
  });
  it("点了关闭：立刻看不见，不等路由落地", () => {
    expect(visible(true, "/positions")).toBe(false);
  });
  it("路由已经回到作战台：看不见", () => {
    expect(visible(false, "/")).toBe(false);
  });
  it("再看还在抽屉路由上、且没点关闭：看得见（关过一次后重开仍有效）", () => {
    expect(visible(false, "/ledger")).toBe(true);
  });
});
