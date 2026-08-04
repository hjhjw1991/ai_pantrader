import { describe, expect, it } from "vitest";
import {
  PROXY_AUDIT_MIN_DAYS, auditProxyFactor, auditProxyFactors,
  lowConfidenceFactorsFrom, pearson, proxyAuditReadiness,
} from "@/lib/backtest/proxy-audit";
import { buildCoverageReport } from "@/lib/backtest/coverage";
import { fakeTradingDays } from "./helpers/fixtures";

const days = fakeTradingDays("2026-08-03", 80);

function series(dates: string[], f: (i: number) => number) {
  return dates.map((date, i) => ({ date, value: f(i) }));
}

describe("皮尔逊相关", () => {
  it("完全正相关 = 1，完全负相关 = −1", () => {
    expect(pearson([1, 2, 3, 4], [3, 5, 7, 9])).toBeCloseTo(1, 12);
    expect(pearson([1, 2, 3, 4], [-1, -2, -3, -4])).toBeCloseTo(-1, 12);
  });

  it("常量序列没有方差，相关无定义 → null，不是 0", () => {
    expect(pearson([1, 1, 1, 1], [1, 2, 3, 4])).toBe(null);
  });

  it("长度不足 2 → null", () => {
    expect(pearson([1], [2])).toBe(null);
  });
});

describe("代理 vs 真值审计（spec §10.3）", () => {
  it("满 60 个交易日、ρ≥0.8 → 通过，不进低置信清单", () => {
    const d = days.slice(0, 60);
    const r = auditProxyFactor({
      factor: "涨停家数",
      proxy: series(d, (i) => i),
      real: series(d, (i) => 2 * i + 1),
    });
    expect(r.status).toBe("ok");
    expect(r.n).toBe(60);
    expect(r.rho).toBeCloseTo(1, 12);
    expect(r.flagged).toBe(false);
  });

  it("ρ<0.8 → 标红，消息里带 ρ 值", () => {
    const d = days.slice(0, 60);
    const r = auditProxyFactor({
      factor: "炸板率",
      proxy: series(d, (i) => i),
      real: series(d, (i) => i + 30 * Math.sin(i)),
    });
    expect(r.status).toBe("ok");
    // 报出的 ρ 固定到 4 位小数（报告展示用），原始值 0.63615016
    expect(r.rho).toBe(0.6362);
    expect(pearson(series(d, (i) => i).map((p) => p.value), series(d, (i) => i + 30 * Math.sin(i)).map((p) => p.value)))
      .toBeCloseTo(0.63615016, 6);
    expect(r.flagged).toBe(true);
    expect(r.message).toContain("0.636");
    expect(r.message).toContain("低置信");
  });

  it("样本不足时报 (n/60)，绝不给出假相关系数", () => {
    // 系统 2026-08-03 才上线真快照，今天只有 1 天 —— 这就是当下的真实状态
    const d = days.slice(0, 1);
    const r = auditProxyFactor({
      factor: "封单额",
      proxy: series(d, (i) => i),
      real: series(d, (i) => i),
    });
    expect(r.status).toBe("insufficient-data");
    expect(r.rho).toBe(null);
    expect(r.n).toBe(1);
    expect(r.required).toBe(60);
    expect(r.message).toContain("1/60");
    expect(r.flagged).toBe(false);
  });

  it("59 天也算不足 —— 门槛就是门槛", () => {
    const d = days.slice(0, 59);
    const r = auditProxyFactor({
      factor: "连板高度",
      proxy: series(d, (i) => i),
      real: series(d, (i) => i * 3),
    });
    expect(r.status).toBe("insufficient-data");
    expect(r.message).toContain("59/60");
    expect(PROXY_AUDIT_MIN_DAYS).toBe(60);
  });

  it("只按两边都有的日期对齐，n 取交集大小", () => {
    const r = auditProxyFactor({
      factor: "情绪温度",
      proxy: series(days.slice(0, 70), (i) => i),
      real: series(days.slice(5, 80), (i) => i * 2),
    });
    // 交集 = days[5..69] = 65 天
    expect(r.n).toBe(65);
    expect(r.status).toBe("ok");
  });

  it("代理序列没有方差 → 判不可用，且标红（不能证明 ρ≥0.8 就不算通过）", () => {
    const d = days.slice(0, 60);
    const r = auditProxyFactor({
      factor: "赚钱效应",
      proxy: series(d, () => 3),
      real: series(d, (i) => i),
    });
    expect(r.status).toBe("no-variance");
    expect(r.rho).toBe(null);
    expect(r.flagged).toBe(true);
    expect(r.message).toContain("方差");
  });
});

describe("和覆盖率报告首页对接", () => {
  const d = days.slice(0, 60);
  const results = auditProxyFactors([
    { factor: "涨停家数", proxy: series(d, (i) => i), real: series(d, (i) => 2 * i) },
    { factor: "炸板率", proxy: series(d, (i) => i), real: series(d, (i) => i + 30 * Math.sin(i)) },
    { factor: "封单额", proxy: series(d.slice(0, 3), (i) => i), real: series(d.slice(0, 3), (i) => i) },
  ]);

  it("只有拿到真 ρ 且 <0.8 的因子进首页清单", () => {
    const low = lowConfidenceFactorsFrom(results);
    expect(low).toEqual([{ name: "炸板率", rho: 0.6362 }]);
  });

  it("样本不足的因子单独列，不混进 ρ 清单也不被静默丢掉", () => {
    const pending = results.filter((r) => r.status === "insufficient-data").map((r) => r.factor);
    expect(pending).toEqual(["封单额"]);
  });

  it("清单能直接喂给 coverage 报告首页", () => {
    const cov = buildCoverageReport({
      requested: { from: days[0], to: days[59] },
      tradingDays: d, replayedDays: d, skippedDays: [],
      lowConfidenceFactors: lowConfidenceFactorsFrom(results),
    });
    expect(cov.lowConfidenceFactors).toEqual([{ name: "炸板率", rho: 0.6362 }]);
    expect(cov.notes.join(" ")).toContain("炸板率");
  });
});

describe("今天能不能跑这份审计", () => {
  it("上线首日只有 1 天真快照 → 明确回答不能，并给出还差几天", () => {
    const r = proxyAuditReadiness(1);
    expect(r.ready).toBe(false);
    expect(r.remaining).toBe(59);
    expect(r.message).toContain("1/60");
  });

  it("满 60 天才算就绪", () => {
    expect(proxyAuditReadiness(59).ready).toBe(false);
    expect(proxyAuditReadiness(60).ready).toBe(true);
    expect(proxyAuditReadiness(60).remaining).toBe(0);
  });
});
