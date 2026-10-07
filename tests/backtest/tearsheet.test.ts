/**
 * tearsheet 的测试。
 *
 * 这里的头号断言不是"某个数算对了"，而是**这份文件能不能离开这个应用**：
 * 没有 CDN、没有 <script>、没有外链资源。一旦有人为了画得好看一点塞个图表库进来，
 * 文件就必须在落到别人机器上那天还打得开 —— 而这条约束很容易在某个下午被忘掉，
 * 不像类型错误那样当场报错，所以要有一条用例盯着它。
 *
 * 第二条是**月度与全年的口径**。月度表那一行的全年列出过一次 bug：
 * "全年"取了 12 月那一格，于是 9 月开始的区间拿到的是单月收益、9 月结束的区间
 * 明明有九个月却显示无数据。两种情形看起来都正常，所以留了两条用例。
 */
import { describe, it, expect } from "vitest";
import type { BacktestReport } from "@/lib/contracts/backtest";
import { DEFAULT_CONSTRAINTS } from "@/lib/contracts/backtest";
import { checkBacktestShape, renderTearsheet } from "@/lib/backtest/tearsheet";

function report(over: Partial<BacktestReport> = {}): BacktestReport {
  const equity = Array.from({ length: 300 }, (_, i) => {
    const d = new Date(Date.UTC(2024, 0, 1) + i * 86400_000).toISOString().slice(0, 10);
    return { date: d, equity: 100000 * (1 + Math.sin(i / 30) * 0.05 + i * 0.0002), position: i % 3 === 0 ? 0.5 : 0 };
  });
  return {
    strategyId: "default",
    strategyVersion: "1.0.0",
    config: { 槽位: undefined } as unknown as BacktestReport["config"],
    range: { from: "2024-01-01", to: "2024-12-31" },
    constraints: DEFAULT_CONSTRAINTS,
    metrics: {
      calmar: 1.23, annualReturn: 0.0812, maxDrawdown: 0.066, sharpe: 0.46,
      winRate: 0.389, profitFactor: 1.1, trades: 126, avgHoldDays: 8.0,
      triggerRate: 0.405, buyDecisions: 316, buyFilled: 128,
    },
    equity,
    coverage: {
      coverage: 0.9315, gapDays: 0, lowConfidenceFactors: [],
      effectiveRange: { from: "2024-01-01", to: "2024-12-31" },
    },
    resultHash: "deadbeef",
    ...over,
  };
}

/** 涨（正）必须是红的：A 股口径反过来会把盈亏读反 */
const RED = "#c0392b";

describe("自包含：这份文件必须离得开本机", () => {
  const html = renderTearsheet(report(), { generatedAt: "2026-10-07 10:00:00" });

  it("不引任何外部资源", () => {
    expect(html).not.toMatch(/https?:\/\//);
    expect(html).not.toMatch(/src\s*=/i);
    expect(html).not.toMatch(/@import/i);
  });

  it("不带 <script>：图表是内联 SVG，不需要运行时", () => {
    expect(html).not.toMatch(/<script/i);
    expect(html).toContain("<svg");
    expect(html).toContain("<polyline");
  });

  it("同一份报告两次渲染完全一致 —— 只有生成时刻是变量", () => {
    expect(renderTearsheet(report(), { generatedAt: "2026-10-07 10:00:00" })).toBe(html);
  });

  it("结构完整：有 doctype，闭合正常", () => {
    expect(html.startsWith("<!DOCTYPE html>")).toBe(true);
    expect(html.trimEnd().endsWith("</html>")).toBe(true);
  });

  it("完整的 UTF-8 中文不会因缺 meta charset 变乱码", () => {
    expect(html).toContain('<meta charset="utf-8">');
  });
});

describe("插值转义", () => {
  it("策略名里带尖括号时不会把它当标签渲染", () => {
    const html = renderTearsheet(report({ strategyId: "<img src=x onerror=alert(1)>" }), { generatedAt: "t" });
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img src=x");
  });

  it("配置 JSON 里的引号被转义，不会截断 <pre>", () => {
    const html = renderTearsheet(report({ strategyVersion: `1"0'0` }), { generatedAt: "t" });
    expect(html).not.toContain('v1"0');
  });
});

describe("退化情形不抛", () => {
  it("零净值点：渲染出来，图表位置给一句说明而不是崩掉", () => {
    const html = renderTearsheet(report({ equity: [] }), { generatedAt: "t" });
    expect(html).toContain("无法作图");
    expect(html).toContain("0 个净值点");
  });

  it("只有一个净值点：同样不崩，且不给空的 <svg>", () => {
    const html = renderTearsheet(report({ equity: [{ date: "2024-01-02", equity: 100, position: 0 }] }), { generatedAt: "t" });
    expect(html).toContain("无法作图");
  });

  it("净值全程持平：不能被除以 0 搞出 NaN 坐标", () => {
    const flat = Array.from({ length: 50 }, (_, i) => ({
      date: `2024-0${i < 28 ? 1 : 2}-${String((i % 28) + 1).padStart(2, "0")}`,
      equity: 100000, position: 0,
    }));
    const html = renderTearsheet(report({ equity: flat }), { generatedAt: "t" });
    expect(html).not.toContain("NaN");
    expect(html).not.toContain("Infinity");
  });

  it("首日归零的净值不产生 NaN 收益", () => {
    const eq = [
      { date: "2024-01-02", equity: 0, position: 0 },
      { date: "2024-01-03", equity: 0, position: 0 },
      { date: "2024-01-04", equity: 0, position: 0 },
    ];
    const html = renderTearsheet(report({ equity: eq }), { generatedAt: "t" });
    expect(html).not.toContain("NaN");
  });

  it("无成交（0 笔）的区间照出不误", () => {
    const html = renderTearsheet(report({
      metrics: { ...report().metrics, trades: 0, triggerRate: null, buyDecisions: 0, buyFilled: 0 },
    }), { generatedAt: "t" });
    expect(html).toContain("无买入决策");
  });
});

describe("涨红跌绿", () => {
  it("正收益用红色，负收益用绿色", () => {
    const html = renderTearsheet(report(), { generatedAt: "t" });
    expect(html).toContain(`--up:${RED}`);
    expect(html).toContain('class="up"');
    expect(html).toContain('class="down"');
  });
});

describe("月度收益表的口径", () => {
  /**
   * 这两条盯着同一个 bug 的两端：全年列早先取的是"12 月那一格",
   * 于是 9 月开局的区间拿到 12 月单月冒充全年，9 月收尾的区间则直接空掉。
   */
  const monthlyOf = (from: string, to: string) => {
    const days: Array<{ date: string; equity: number; position: number }> = [];
    const start = Date.parse(`${from}T00:00:00Z`);
    const end = Date.parse(`${to}T00:00:00Z`);
    for (let t = start, v = 100000; t <= end; t += 86400_000, v += 10) {
      days.push({ date: new Date(t).toISOString().slice(0, 10), equity: v, position: 0 });
    }
    const mk = report({ equity: days, range: { from, to } });
    return renderTearsheet(mk, { generatedAt: "t" });
  };

  it("区间从年中开始 → 首年没有上年基准，全年列必须留空而不是拿单月凑", () => {
    const html = monthlyOf("2024-09-01", "2024-12-31");
    // 表体只有一行 2024，全年那一格必须是 na（·）
    const body = html.slice(html.indexOf("<tbody>"), html.indexOf("</tbody>"));
    const cells = body.split("</tr>")[0]!.split("<td");
    expect(cells[cells.length - 1]).toContain('class="na"');
  });

  it("区间跨到次年且次年未满 12 个月 → 全年列要有数，不能用 12 月那一格", () => {
    const html = monthlyOf("2024-11-01", "2025-09-30");
    const rows = html.slice(html.indexOf("<tbody>"), html.indexOf("</tbody>")).split("</tr>").filter(r => r.includes("<th>"));
    expect(rows.length).toBe(2);
    // 2025 行（第二行）全年列必须有具体数字：净值单调递增，全年必为正且标红
    expect(rows[1]).toContain('class="up yr"');
    expect(rows[1]).not.toContain('<td class="na">·</td></tr>');
  });

  it("区间的第一个月没有上月基准，那一格是「·」不是 0.0%", () => {
    const html = monthlyOf("2024-02-01", "2024-04-30");
    const body = html.slice(html.indexOf("<tbody>"), html.indexOf("</tbody>"));
    expect(body).toContain("·");
    // 2 月是第一格：不能出现"0.0%"这种持平的假象
    const firstRow = body.split("</tr>")[0]!;
    const firstMonthCell = firstRow.split("<td")[1]!;
    expect(firstMonthCell).toContain('class="na"');
  });
});

describe("checkBacktestShape", () => {
  it("完整报告通过", () => {
    expect(checkBacktestShape(report()).ok).toBe(true);
  });

  it("参数扫描报告会被挡掉，不会被当成回测渲染出半份报告", () => {
    const sweep = { strategyId: "x", best: {}, heatmap: {}, sensitivity: [], warnings: [] };
    const r = checkBacktestShape(sweep);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.missing).toContain("metrics");
  });

  it("缺哪个字段报哪个，不笼统说一句'不是回测报告'", () => {
    const bad = { ...report() } as Record<string, unknown>;
    delete bad["coverage"];
    delete bad["resultHash"];
    const r = checkBacktestShape(bad);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.missing).toContain("coverage");
      expect(r.missing).toContain("resultHash");
    }
  });

  it("null / 非对象不应该抛", () => {
    for (const x of [null, undefined, 42, "x", []]) {
      expect(checkBacktestShape(x).ok).toBe(false);
    }
  });
});
