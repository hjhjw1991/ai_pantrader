import { describe, it, expect } from "vitest";
import { parseArchiveRows } from "@/components/archive-list";
import { createLatestGate, deleteOutcome } from "@/components/ArchiveSync";

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

describe("删档响应的归类", () => {
  it("2xx → 已删", () => {
    expect(deleteOutcome({ ok: true, status: 200 })).toBe("deleted");
  });

  it("404 → 本来就不在了：当已删处理、照样刷新，不让鬼行留在表里", () => {
    expect(deleteOutcome({ ok: false, status: 404 })).toBe("alreadyGone");
  });

  it("其它失败 → 如实报错", () => {
    expect(deleteOutcome({ ok: false, status: 500 })).toBe("failed");
    expect(deleteOutcome({ ok: false, status: 400 })).toBe("failed");
  });
});

describe("列表请求只认最新一号", () => {
  it("先发后回的旧响应作废，新响应生效", () => {
    const g = createLatestGate();
    const first = g.next();
    const second = g.next();
    // 第二个先回来：它是最新的，生效
    expect(g.isLatest(second)).toBe(true);
    // 第一个后回来：已经过期，不许把旧列表盖上去（否则刚删的行会复活）
    expect(g.isLatest(first)).toBe(false);
  });

  it("各自独立的发号器互不干扰", () => {
    const a = createLatestGate(), b = createLatestGate();
    const ta = a.next();
    b.next(); b.next();
    expect(a.isLatest(ta)).toBe(true);
  });
});
