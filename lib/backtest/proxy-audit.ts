import { LOW_CONFIDENCE_RHO } from "@/lib/backtest/coverage";

/**
 * 代理误差量化（spec §10.3 / R4）。
 *
 * 情绪类因子（涨停家数、连板高度、炸板率…）在历史区间上是**日线代理重建**的，不是真值：
 * 涨停池、板块榜是东财当日接口，不可回补（README 坑 7）。真快照从 2026-08-03 起攒。
 *
 * 所以这个模块的产出是一份诚实的声明，而不是一个漂亮的数字：
 *   - 攒满 60 个交易日真快照才给相关系数；
 *   - 不满就报 "样本不足 (n/60)"，**绝不**用手头几天算个 ρ 出来充数 ——
 *     3 天的 ρ=0.97 只说明这 3 天像，什么都证明不了；
 *   - ρ<0.8 的因子进回测报告首页标红清单（spec §10.3 原话：不藏）。
 *
 * 现实状态（2026-08-03 上线）：真快照只有 1 天，这份审计**今天跑不了**，
 * 计算逻辑先写好并用合成序列测通，等数据攒够直接开跑。
 */

/** 满多少个交易日真快照才允许出相关性结论（spec §10.3） */
export const PROXY_AUDIT_MIN_DAYS = 60;

export interface SeriesPoint {
  date: string;
  value: number;
}

export interface ProxyAuditInput {
  factor: string;
  /** 日线代理重建出来的序列 */
  proxy: SeriesPoint[];
  /** 同一因子用真快照算出来的序列 */
  real: SeriesPoint[];
  /** 覆盖门槛，仅用于测试与特殊场景，默认 60 */
  minDays?: number;
}

export type ProxyAuditStatus = "ok" | "insufficient-data" | "no-variance";

export interface ProxyAuditResult {
  factor: string;
  status: ProxyAuditStatus;
  /** 对齐后的有效样本天数 */
  n: number;
  required: number;
  /** 只有 status === "ok" 时才是数字。其余一律 null —— 不给假相关 */
  rho: number | null;
  /** true = 该因子要在回测报告首页标红 */
  flagged: boolean;
  message: string;
}

/** 皮尔逊相关。任一序列无方差或样本 < 2 → null（无定义，不是 0） */
export function pearson(xs: number[], ys: number[]): number | null {
  const n = Math.min(xs.length, ys.length);
  if (n < 2) return null;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) {
    num += (xs[i] - mx) * (ys[i] - my);
    dx += (xs[i] - mx) ** 2;
    dy += (ys[i] - my) ** 2;
  }
  if (dx === 0 || dy === 0) return null;
  return num / Math.sqrt(dx * dy);
}

/** 按日期取交集对齐。代理和真值的采集口径不同，日期不会天然一致 */
export function alignSeries(
  proxy: SeriesPoint[], real: SeriesPoint[]
): { dates: string[]; x: number[]; y: number[] } {
  const realMap = new Map(real.map((p) => [p.date, p.value]));
  const dates: string[] = [];
  const x: number[] = [];
  const y: number[] = [];
  for (const p of [...proxy].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))) {
    const rv = realMap.get(p.date);
    if (rv === undefined) continue;
    dates.push(p.date);
    x.push(p.value);
    y.push(rv);
  }
  return { dates, x, y };
}

export function auditProxyFactor(i: ProxyAuditInput): ProxyAuditResult {
  const required = i.minDays ?? PROXY_AUDIT_MIN_DAYS;
  const { x, y } = alignSeries(i.proxy, i.real);
  const n = x.length;

  if (n < required) {
    return {
      factor: i.factor, status: "insufficient-data", n, required, rho: null, flagged: false,
      message:
        `${i.factor}：真快照样本不足 (${n}/${required} 交易日)，暂不出相关性结论。` +
        "真快照自 2026-08-03 起攒，攒满后本项自动可算 —— 在此之前该因子的回测结论天然带代理误差。",
    };
  }

  const rho = pearson(x, y);
  if (rho === null) {
    return {
      factor: i.factor, status: "no-variance", n, required, rho: null, flagged: true,
      // 无方差意味着"证明不了 ρ≥0.8"，那就按低置信处理，不给通过
      message: `${i.factor}：序列无方差（代理或真值恒定 ${required} 天），相关性无定义，按低置信处理。`,
    };
  }

  const rounded = Number(rho.toFixed(4));
  const flagged = rounded < LOW_CONFIDENCE_RHO;
  return {
    factor: i.factor, status: "ok", n, required, rho: rounded, flagged,
    message: flagged
      ? `${i.factor}：低置信因子 ρ=${rounded}（<${LOW_CONFIDENCE_RHO}），回测报告首页标红。`
      : `${i.factor}：ρ=${rounded}，代理可用。`,
  };
}

export function auditProxyFactors(inputs: ProxyAuditInput[]): ProxyAuditResult[] {
  return inputs.map(auditProxyFactor);
}

/**
 * 给 coverage 报告首页用的清单。
 * 只收 status==="ok" 且 ρ<0.8 的 —— 契约里 lowConfidenceFactors 的 rho 是 number，
 * 装不了"样本不足"这种状态。样本不足的因子要靠调用方另列（见 ProxyAuditResult.status）。
 */
export function lowConfidenceFactorsFrom(
  results: ProxyAuditResult[]
): Array<{ name: string; rho: number }> {
  return results
    .filter((r) => r.status === "ok" && r.rho !== null && r.flagged)
    .map((r) => ({ name: r.factor, rho: r.rho as number }))
    .sort((a, b) => a.rho - b.rho);
}

export interface ProxyAuditReadiness {
  ready: boolean;
  have: number;
  required: number;
  remaining: number;
  message: string;
}

/** 直接回答"今天能不能跑这份审计"。上线首日答案是不能，还差 59 天 */
export function proxyAuditReadiness(
  realSnapshotDays: number, required = PROXY_AUDIT_MIN_DAYS
): ProxyAuditReadiness {
  const remaining = Math.max(0, required - realSnapshotDays);
  return {
    ready: remaining === 0,
    have: realSnapshotDays,
    required,
    remaining,
    message: remaining === 0
      ? `真快照已满 ${realSnapshotDays}/${required} 交易日，可跑 proxy-vs-real 审计。`
      : `真快照 ${realSnapshotDays}/${required} 交易日，还差 ${remaining} 个交易日，本审计暂不可跑。`,
  };
}
