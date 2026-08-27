"use client";

import { useCallback, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { readNdjson } from "@/components/ndjson";

/**
 * 手动重扫候选池 = 先采一轮全市场行情，再让页面重算候选。
 *
 * 为什么必须先采：候选池不是定时任务算好存库的，它在每次渲染时由策略引擎现算。
 * 所以"只重算"在行情没变的情况下必然得到同一批候选 —— 真正让它变化的是新的快照。
 *
 * 为什么要进度条：一轮全市场 5,888 只、约 99 个批次，实测 45 秒。
 * 没有进度的 45 秒会被当成卡死，人就会去点第二次（而连点正是限频的起因）。
 *
 * 读的是 NDJSON 流，不是等整个请求回来 —— 见 /api/collect 的注释。
 */

export interface CollectState {
  busy: boolean;
  /** 已完成批次 / 总批次；total=0 表示还没收到第一条进度 */
  done: number;
  total: number;
  written: number;
  failedBatches: number;
  msg: { kind: "ok" | "err"; text: string } | null;
}

const IDLE: CollectState = {
  busy: false, done: 0, total: 0, written: 0, failedBatches: 0, msg: null,
};

export function useCollectScan(): CollectState & { run: () => void } {
  const router = useRouter();
  const [s, setS] = useState<CollectState>(IDLE);
  // 用 ref 挡住重入：按钮 disabled 只挡鼠标，键盘回车与快速双击仍可能连发两次
  const running = useRef(false);

  const run = useCallback(async () => {
    if (running.current) return;
    running.current = true;
    setS({ ...IDLE, busy: true });
    try {
      const r = await fetch("/api/collect", { method: "POST" });
      const outcome = await readNdjson(r, ev => {
        if (ev.phase === "snapshot" || ev.phase === "minute") {
          setS(prev => ({
            ...prev,
            busy: true,
            done: Number(ev.done ?? 0),
            total: Number(ev.total ?? 0),
            written: Number(ev.written ?? 0),
            failedBatches: Number(ev.failedBatches ?? 0),
          }));
        }
      });
      if (outcome.kind === "rejected") {
        // 间隔保护 / 已有一轮在跑：还没开跑就被拒，走的是普通 JSON
        setS({ ...IDLE, msg: { kind: "err", text: outcome.error } });
        return;
      }
      const last = outcome.last;

      // 最后一行是成败判定。流式响应的状态码在第一个字节就定了，
      // 中途失败改不了状态码，所以结论只能从消息体里读
      if (last?.phase === "done") {
        const stats = (last.stats ?? {}) as Record<string, number>;
        const failed = Number(stats.snapshotFailedBatches ?? 0);
        setS(prev => ({
          ...prev, busy: false,
          msg: {
            kind: failed > 0 ? "err" : "ok",
            text: `采集完成：快照 ${stats.snapshotWritten ?? 0} 条`
              + (failed > 0 ? `，失败批次 ${failed}` : ""),
          },
        }));
      } else {
        setS(prev => ({
          ...prev, busy: false,
          msg: { kind: "err", text: String(last?.reason ?? "采集中断，未收到结束消息") },
        }));
      }
      // 无论成败都刷新：部分成功也意味着候选池该重算
      router.refresh();
    } catch (e) {
      setS({ ...IDLE, msg: { kind: "err", text: `采集请求失败：${(e as Error).message}` } });
    } finally {
      running.current = false;
    }
  }, [router]);

  return { ...s, run };
}

/** 进度条。total 未知时画成不确定态，不假装知道百分比 */
export function CollectProgress({ s }: { s: CollectState }) {
  if (!s.busy && s.msg === null) return null;

  const pct = s.total > 0 ? Math.round((s.done / s.total) * 100) : null;
  return (
    <div className="mt-2 flex flex-col gap-1">
      {s.busy ? (
        <>
          <div className="h-1 w-full rounded-sm bg-panel-2 overflow-hidden">
            <div
              className={pct === null ? "h-full w-1/3 bg-info animate-pulse" : "h-full bg-info"}
              style={pct === null ? undefined : { width: `${pct}%` }}
            />
          </div>
          <span className="text-ink-3 text-[11px] num">
            {pct === null
              ? "采集中…（正在取标的清单）"
              : `采集中 ${s.done}/${s.total} 批（${pct}%） · 已写入 ${s.written} 条`
                + (s.failedBatches > 0 ? ` · 失败 ${s.failedBatches} 批` : "")}
          </span>
        </>
      ) : (
        <span className={s.msg!.kind === "ok" ? "text-down text-[11px]" : "text-danger text-[11px]"}>
          {s.msg!.text}
        </span>
      )}
    </div>
  );
}

/**
 * 候选池面板头上的重扫按钮 + 进度条。
 * 采完自动 router.refresh()，候选池随页面重算刷新，用户不需要再点一次。
 */
export function CandidateScanButton({ intervalMin }: { intervalMin: number }) {
  const s = useCollectScan();
  return (
    <div className="flex flex-col items-end">
      <button
        type="button"
        onClick={s.run}
        disabled={s.busy}
        className="border border-line-2 rounded-sm px-2 py-0.5 text-[11px] text-ink-2 hover:text-ink hover:bg-panel-2 disabled:opacity-40"
        title={
          `候选池在每次页面渲染时由策略引擎现算，真正让它变化的是新的行情快照。\n`
          + `定时采集 ${intervalMin} 分钟一轮；这个按钮立刻采一轮（全市场约 45 秒）再重算。`
        }
      >
        {s.busy ? "重扫中…" : "立即重扫"}
      </button>
      <div className="w-56">
        <CollectProgress s={s} />
      </div>
    </div>
  );
}
