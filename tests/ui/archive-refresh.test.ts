import { describe, it, expect } from "vitest";
import { parseArchiveRows } from "@/components/archive-list";

/**
 * 存档列表的响应解析。
 *
 * 删档、跑完回测、扫完参数三处都走这一段：拿到新列表就把表格重画，
 * 拿不到就如实退回（而不是把表格清空）。所以"取不到"和"真的空了"
 * 必须分得清 —— 混成空数组的话，接口一挂列表就变空，
 * 人看到的是"我的档全没了"，而那些档好端端在库里。
 */
describe("存档列表响应", () => {
  it("正常响应取出行", () => {
    const rows = [{ id: "20260930233656188-k5n0", ts: "2026-09-30 23:36:56" }];
    expect(parseArchiveRows({ rows })).toEqual(rows);
  });

  it("空数组是合法答案 —— 存档真的被删空了", () => {
    expect(parseArchiveRows({ rows: [] })).toEqual([]);
  });

  it("没有 rows 字段 → null，不拿空数组冒充", () => {
    expect(parseArchiveRows({})).toBeNull();
    expect(parseArchiveRows({ error: "数据库打不开" })).toBeNull();
  });

  it("rows 不是数组 → null", () => {
    expect(parseArchiveRows({ rows: "坏了" })).toBeNull();
    expect(parseArchiveRows({ rows: { a: 1 } })).toBeNull();
  });

  it("响应根本不是 JSON（解析失败传进来的是 null）→ null", () => {
    expect(parseArchiveRows(null)).toBeNull();
    expect(parseArchiveRows(undefined)).toBeNull();
    expect(parseArchiveRows("<html>502 Bad Gateway</html>")).toBeNull();
  });
});
