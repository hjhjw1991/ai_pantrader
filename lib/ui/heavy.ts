/**
 * 重活单飞锁：回测与参数扫描同一时刻只许跑一个。
 *
 * 不是防手滑，是硬约束。实测 0.38 秒/交易日：四年跨度的单次回测约 6 分钟，
 * 而一次 36 点的参数扫描是 36 次完整回测 —— 同样跨度约 3.7 小时。
 * Node 是单线程的，两件重活并行不会各自快一点，只会把 CPU 切碎、一起变慢，
 * 同时把整个网站拖得更卡。
 *
 * 回测和扫描共用同一把锁，而不是各管各的：它们抢的是同一个 CPU，
 * 分成两把锁只会让"回测跑着的时候还能开扫描"这种最坏组合合法化。
 *
 * 只在进程内设防。这是本机单进程应用，锁挂在 globalThis 上而不是模块作用域 ——
 * dev 下 HMR 会反复重新求值模块，挂模块里等于没有锁
 * （和 lib/ui/db 的只读连接、tableCountsCached 的缓存同一个理由）。
 */

export type HeavyKind = "backtest" | "sweep";

export interface HeavyJob {
  kind: HeavyKind;
  /** 给人看的说明，被拒时原样回给用户，让他知道是什么占着 */
  label: string;
  startedAt: number;
  /** 协作式取消标志。回放在两个交易日之间检查它 */
  abort: { aborted: boolean };
}

const KIND_CN: Record<HeavyKind, string> = { backtest: "回测", sweep: "参数扫描" };

function slot(): { job: HeavyJob | null } {
  const g = globalThis as unknown as { __pantraderHeavy?: { job: HeavyJob | null } };
  return (g.__pantraderHeavy ??= { job: null });
}

export type AcquireResult =
  | { ok: true; job: HeavyJob }
  | { ok: false; reason: string };

export function tryAcquire(
  kind: HeavyKind,
  label: string,
  now: number = Date.now()
): AcquireResult {
  const s = slot();
  if (s.job !== null) {
    const sec = Math.round((now - s.job.startedAt) / 1000);
    return {
      ok: false,
      reason:
        `已有一个${KIND_CN[s.job.kind]}在跑（${s.job.label}，已跑 ${sec} 秒）。`
        + `先取消它，或等它跑完 —— 两件重活并行只会一起变慢。`,
    };
  }
  const job: HeavyJob = { kind, label, startedAt: now, abort: { aborted: false } };
  s.job = job;
  return { ok: true, job };
}

/** 释放。只释放自己那把，避免把接手者的锁误删 */
export function release(job: HeavyJob): void {
  const s = slot();
  if (s.job === job) s.job = null;
}

export function currentHeavy(): HeavyJob | null {
  return slot().job;
}
