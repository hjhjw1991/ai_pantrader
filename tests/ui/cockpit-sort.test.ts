import { describe, expect, it } from "vitest";
import {
  NO_SORT, applyGroupSort, findSortOption, initialDir, rel, sortOptionsFor,
} from "@/lib/ui/cockpit-sort";
import type { CockpitItem, ItemGroup } from "@/lib/ui/adapters/cockpit";

/**
 * 作战台左侧自选列表的排序选项。
 *
 * 这里盯的是两件容易悄悄走样的事：
 *   1. 每组只能挂**这一组的行真的会有值**的维度 —— 挂一列恒为 null 的，排序等于没做，
 *      而用户只会以为功能坏了。
 *   2. 派生算式（距触发 / 距止损）要和决策卡上显示的那个数是同一条，不能各写一遍。
 */

function item(group: ItemGroup, code: string, patch: Partial<CockpitItem> = {}): CockpitItem {
  return {
    key: `${group}:${code}`, code, name: null, group,
    action: "持有", tone: "buy", account: null,
    triggerPx: null, stopPx: null, targetPx: null,
    targetRef: false, targetSource: null,
    rrRatio: null, size: null, score: null, mainline: null,
    thesis: "", reasons: [], hints: [], lean: null,
    daily: null, weekly: null, resistance: null, support: null,
    filters: [], lowConf: [],
    price: null, pct: null, quoteTs: null, spark: [],
    ...patch,
  };
}

const GROUPS: ItemGroup[] = ["候选", "持仓", "观察"];
const keys = (xs: CockpitItem[]) => xs.map(x => x.code);

describe("rel", () => {
  it("a 相对 b 的差比", () => {
    expect(rel(11, 10)).toBeCloseTo(0.1);
    expect(rel(9, 10)).toBeCloseTo(-0.1);
  });
  it("缺值或分母非正 → null（而不是 Infinity / NaN）", () => {
    expect(rel(null, 10)).toBeNull();
    expect(rel(10, null)).toBeNull();
    expect(rel(10, 0)).toBeNull();
  });
});

describe("sortOptionsFor", () => {
  it("三组都有选项，且每组的 key 不重复", () => {
    for (const g of GROUPS) {
      const opts = sortOptionsFor(g);
      expect(opts.length).toBeGreaterThan(1);
      expect(new Set(opts.map(o => o.key)).size).toBe(opts.length);
    }
  });

  it("label 不撞车：同组内不重复", () => {
    for (const g of GROUPS) {
      const labels = sortOptionsFor(g).map(o => o.label);
      expect(new Set(labels).size).toBe(labels.length);
    }
  });

  /**
   * 「建议仓位」「评分」只有候选组才有值（引擎只给候选打分）。
   * 给持仓 / 观察挂这两个维度，排完顺序没变 —— 用户只会以为排序坏了。
   */
  it("只剩候选组才有「评分」「建议仓位」", () => {
    for (const g of GROUPS) {
      const keysOf = new Set(sortOptionsFor(g).map(o => o.key));
      if (g === "候选") {
        expect(keysOf.has("score")).toBe(true);
        expect(keysOf.has("size")).toBe(true);
      } else {
        expect(keysOf.has("score")).toBe(false);
        expect(keysOf.has("size")).toBe(false);
      }
    }
  });

  /** 距止损是持仓组独有的问法；距触发价对候选和观察都有意义 */
  it("「距止损」只在持仓组，「距触发价」不在持仓组", () => {
    const 持有 = new Set(sortOptionsFor("持仓").map(o => o.key));
    expect(持有.has("toStop")).toBe(true);
    expect(持有.has("toTrigger")).toBe(false);

    const 候选 = new Set(sortOptionsFor("候选").map(o => o.key));
    expect(候选.has("toTrigger")).toBe(true);
    expect(候选.has("toStop")).toBe(false);
  });
});

describe("findSortOption", () => {
  it("取不到时返回 null（而不是找一个别的维度凑数）", () => {
    expect(findSortOption("候选", "不存在的维度")).toBeNull();
    expect(findSortOption("持仓", NO_SORT)).toBeNull();
  });
  it("能取到时返回带 value 的那个定义", () => {
    const o = findSortOption("候选", "score");
    expect(o?.value(item("候选", "600000", { score: 0.8 }))).toBe(0.8);
  });
});

describe("initialDir", () => {
  /** 方向由这一组**实际的取值**判断，不是写死的 —— 所以 cases 里要给真行 */
  const rows = [item("候选", "600000", { code: "600000", score: 0.4, pct: 1.2 })];

  it("数值维度默认降序 —— 想先看最大 / 最高 / 最危险的那个", () => {
    expect(initialDir("候选", "score", rows)).toBe("desc");
    expect(initialDir("候选", "pct", rows)).toBe("desc");
    expect(initialDir("持仓", "toStop", [item("持仓", "600000", { price: 10, stopPx: 9 })])).toBe("desc");
  });
  it("代码是文本，默认升序", () => {
    expect(initialDir("候选", "code", rows)).toBe("asc");
  });
  it("整组这一维都取不到值时退化成 desc，不抛错", () => {
    expect(initialDir("候选", "score", [item("候选", "600000")])).toBe("desc");
  });
  it("取不到这个维度时也不抛错", () => {
    expect(initialDir("候选", "没有这个维度", rows)).toBe("desc");
  });
});

describe("applyGroupSort", () => {
  it("没选维度 → 原顺序原样返回（同一个数组对象）", () => {
    const list = [item("候选", "600000"), item("候选", "600001")];
    expect(applyGroupSort(list, null, "desc")).toBe(list);
  });

  it("候选按评分降序：分高的在前", () => {
    const list = [
      item("候选", "600000", { score: 0.4 }),
      item("候选", "300750", { score: 0.9 }),
      item("候选", "000001", { score: 0.7 }),
    ];
    const out = applyGroupSort(list, findSortOption("候选", "score"), "desc");
    expect(keys(out)).toEqual(["300750", "000001", "600000"]);
  });

  /** 无快照就没现价，算不出市值那种错我们不犯 —— 无值恒排最后 */
  it("没采到价的那几只恒排最后，降序升序都一样", () => {
    const list = [
      item("观察", "600000", { price: null }),
      item("观察", "300750", { price: 180 }),
      item("观察", "000001", { price: 12 }),
    ];
    const by = findSortOption("观察", "price")!;
    expect(keys(applyGroupSort(list, by, "desc"))).toEqual(["300750", "000001", "600000"]);
    expect(keys(applyGroupSort(list, by, "asc"))).toEqual(["000001", "300750", "600000"]);
  });

  /**
   * 观察池最想看的是"哪几只快到买点了"。
   * 距触发价 = 触发价 / 现价 - 1，越接近 0 越接近买点，降序时它就是排在最前面的 ——
   * 这个方向对了，默认点开就能用。
   */
  it("观察按距触发价降序：已到价的（正数，现价跌到触发价下方）最前，其次最接近买点的", () => {
    const list = [
      item("观察", "600000", { price: 10, triggerPx: 8 }),      // -0.20，还差得远
      item("观察", "300750", { price: 10, triggerPx: 9.9 }),    // -0.01，基本到价
      item("观察", "000001", { price: 10, triggerPx: 9 }),      // -0.10
      item("观察", "002594", { price: 9, triggerPx: 9.9 }),     // +0.10，现价已在触发价下方 = 已到价
    ];
    const by = findSortOption("观察", "toTrigger")!;
    expect(by.value(list[3])).toBeCloseTo(0.1, 10);
    expect(by.value(list[3]) as number).toBeGreaterThan(0);
    const out = applyGroupSort(list, by, "desc");
    expect(keys(out)).toEqual(["002594", "300750", "000001", "600000"]);
  });

  it("持仓按距止损降序：最贴近止损的在前", () => {
    const list = [
      item("持仓", "600000", { price: 10, stopPx: 8 }),     // -0.20
      item("持仓", "300750", { price: 10, stopPx: 9.5 }),   // -0.05，最危险
      item("持仓", "000001", { price: 10, stopPx: 9 }),     // -0.10
    ];
    const out = applyGroupSort(list, findSortOption("持仓", "toStop"), "desc");
    expect(keys(out)).toEqual(["300750", "000001", "600000"]);
  });

  it("盘点：排完还是那几只，不会多也不会少", () => {
    const list = [
      item("候选", "600000", { score: 0.4 }),
      item("候选", "300750", { score: null }),
      item("候选", "000001", { score: 0.7 }),
    ];
    const out = applyGroupSort(list, findSortOption("候选", "score"), "desc");
    expect(out).toHaveLength(3);
    expect(new Set(keys(out))).toEqual(new Set(["600000", "300750", "000001"]));
  });
});
