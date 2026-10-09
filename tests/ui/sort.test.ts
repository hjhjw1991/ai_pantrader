import { describe, expect, it } from "vitest";
import {
  absValue, defaultDir, nextSortState, sortRows, type SortState, type SortableValue,
} from "@/lib/ui/sort";

type Row = { code: string; mv: SortableValue };

const rows = (): Row[] => [
  { code: "600000", mv: 12000 },
  { code: "600001", mv: null },      // 无快照 → 算不出市值
  { code: "300750", mv: 88000 },
  { code: "000001", mv: 3500 },
];

const codes = (r: Row[]) => r.map((x) => x.code);
const byMv = (r: Row) => r.mv;

describe("sortRows", () => {
  it("数值降序：最大的在前", () => {
    expect(codes(sortRows(rows(), byMv, "desc"))).toEqual([
      "300750", "600000", "000001", "600001",
    ]);
  });

  it("数值升序：最小的在前", () => {
    expect(codes(sortRows(rows(), byMv, "asc"))).toEqual([
      "000001", "600000", "300750", "600001",
    ]);
  });

  /**
   * 这条是整个排序里唯一会**骗人**的地方。
   *
   * 无快照的仓位算不出市值，若按 0 处理，升序时它会排在最前 ——
   * 读起来像"这是最小的一笔仓，可以随手清掉"，而它可能是当天市值最大的那只，
   * 只是这一轮没采到价。所以无值恒排最后，升降序都一样。
   */
  it("无值的行恒定排最后，升序降序都一样", () => {
    expect(codes(sortRows(rows(), byMv, "desc")).at(-1)).toBe("600001");
    expect(codes(sortRows(rows(), byMv, "asc")).at(-1)).toBe("600001");
  });

  it("多个无值的行落在最后，且彼此保持原顺序", () => {
    const rs: Row[] = [
      { code: "a", mv: 3 }, { code: "b", mv: null },
      { code: "c", mv: 1 }, { code: "d", mv: null },
    ];
    expect(codes(sortRows(rs, byMv, "desc"))).toEqual(["a", "c", "b", "d"]);
  });

  it("整列无值时保持原顺序", () => {
    const rs: Row[] = [{ code: "a", mv: null }, { code: "b", mv: null }];
    expect(codes(sortRows(rs, byMv, "desc"))).toEqual(["a", "b"]);
  });

  /**
   * 保留原顺序的意义在数据刷新时：软刷新把新价带下来一批，
   * 市值相同的几只不该因为这次刷新换了位置 —— 否则整张表每分钟都在跳动。
   */
  it("取值相等的两行保持原顺序", () => {
    const rs: Row[] = [
      { code: "a", mv: 100 }, { code: "b", mv: 100 }, { code: "c", mv: 50 },
    ];
    expect(codes(sortRows(rs, byMv, "desc"))).toEqual(["a", "b", "c"]);
    expect(codes(sortRows(rs, byMv, "asc"))).toEqual(["c", "a", "b"]);
  });

  it("文本列按本地语序排", () => {
    const rs: Row[] = [
      { code: "x", mv: "银行Ⅱ" }, { code: "y", mv: "半导体" }, { code: "z", mv: "白酒" },
    ];
    // zh-Hans-CN 下应按拼音首字母：白酒(B) < 半导体(B) < 银行(Y)
    const asc = sortRows(rs, byMv, "asc");
    expect(asc[0]!.mv).toBe("白酒");
    expect(asc.at(-1)!.mv).toBe("银行Ⅱ");
  });

  it("不改动原数组", () => {
    const rs = rows();
    const before = codes(rs);
    sortRows(rs, byMv, "desc");
    expect(codes(rs)).toEqual(before);
  });
});

describe("defaultDir", () => {
  it("数值列首次点击给降序", () => {
    expect(defaultDir(rows(), byMv)).toBe("desc");
  });

  it("文本列首次点击给升序", () => {
    const rs: Row[] = [{ code: "a", mv: "银行Ⅱ" }];
    expect(defaultDir(rs, byMv)).toBe("asc");
  });

  /**
   * 取**第一个非空值**来判类型，而不是拿第 0 行的值：
   * 第 0 行恰好是 null 太常见了（排第一位的往往就是没采到价的那只），
   * 只看第 0 行会把数值列判成文本列，首次点击就变成升序。
   */
  it("首行无值、次行有值时类型仍判对", () => {
    const rs: Row[] = [{ code: "a", mv: null }, { code: "b", mv: 3 }];
    expect(defaultDir(rs, byMv)).toBe("desc");
  });

  it("整列无值时不抛异常", () => {
    const rs: Row[] = [{ code: "a", mv: null }];
    expect(() => defaultDir(rs, byMv)).not.toThrow();
  });
});

/**
 * 点一次表头 → 下一个状态。三态循环，落到实处就是一种习惯：
 * 看一眼"市值最大的几只"，再点一次看反向，第三次回到原始顺序。
 *
 * 循环回不到原点的话，人只能刷新整页 —— 而这张表每分钟自己刷一次，
 * 排状态保留着，等于刷新也没用。
 */
describe("nextSortState", () => {
  const rs = rows();

  it("数值列：降序 → 升序 → 取消 → 降序", () => {
    const a = nextSortState<Row>(null, "mv", rs, byMv);
    expect(a).toEqual({ key: "mv", dir: "desc" });
    const b = nextSortState<Row>(a, "mv", rs, byMv);
    expect(b).toEqual({ key: "mv", dir: "asc" });
    const c = nextSortState<Row>(b, "mv", rs, byMv);
    expect(c).toBeNull();
    const d = nextSortState<Row>(c, "mv", rs, byMv);
    expect(d).toEqual({ key: "mv", dir: "desc" });
  });

  it("文本列：升序起手，循环同样能回原点", () => {
    const trs: Row[] = [{ code: "a", mv: "银行Ⅱ" }];
    const byName = (r: Row) => r.mv;
    expect(nextSortState<Row>(null, "name", trs, byName)).toEqual({ key: "name", dir: "asc" });
    expect(nextSortState<Row>({ key: "name", dir: "asc" }, "name", trs, byName))
      .toEqual({ key: "name", dir: "desc" });
    expect(nextSortState<Row>({ key: "name", dir: "desc" }, "name", trs, byName)).toBeNull();
  });

  /** 换了列就从头开始，不带上一列的方向过来 */
  it("换一列：丢弃上一列的方向，按新列的默认方向起手", () => {
    const prev: SortState<Row> = { key: "mv", dir: "asc" };
    const trs: Row[] = [{ code: "a", mv: "银行Ⅱ" }];
    expect(nextSortState<Row>(prev, "name", trs, () => "银行Ⅱ"))
      .toEqual({ key: "name", dir: "asc" });
  });
});

/**
 * 观察池「距触发%」：显示带符号的 (现价-触发价)/触发价，表头说"最接近买点的排前面"。
 * 按带符号值 + 数值默认降序排，排最前的是离得最远的那只 —— 和表头正好相反。
 * 所以排序取 |偏离|、首次点击升序。
 */
describe("距触发% 排序：|偏离| 升序起手", () => {
  type W = { code: string; ratio: number | null };
  const ws: W[] = [
    { code: "far", ratio: 0.2 },      // 还在触发价上方 20%
    { code: "none", ratio: null },    // 无快照
    { code: "near", ratio: 0.01 },    // 差 1%
    { code: "hit", ratio: -0.03 },    // 已跌破触发价 3%
  ];
  const by = absValue<W>((r) => r.ratio);

  it("absValue：数值取绝对值，null 保持 null", () => {
    expect(ws.map(by)).toEqual([0.2, null, 0.01, 0.03]);
  });

  it("指定 firstDir=asc 时首次点击是升序，循环仍是 升 → 降 → 取消", () => {
    const a = nextSortState<W>(null, "deltaRatio", ws, by, "asc");
    expect(a).toEqual({ key: "deltaRatio", dir: "asc" });
    const b = nextSortState<W>(a, "deltaRatio", ws, by, "asc");
    expect(b).toEqual({ key: "deltaRatio", dir: "desc" });
    expect(nextSortState<W>(b, "deltaRatio", ws, by, "asc")).toBeNull();
  });

  it("首次点击：最接近买点的在前，无值仍排最后", () => {
    const st = nextSortState<W>(null, "deltaRatio", ws, by, "asc")!;
    expect(sortRows(ws, by, st.dir).map((r) => r.code)).toEqual(["near", "hit", "far", "none"]);
  });
});
