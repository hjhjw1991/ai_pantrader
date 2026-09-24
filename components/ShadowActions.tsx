"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/**
 * 影子盘切换的三个按钮：批准 / 否决 / 回滚。
 *
 * 每个动作都要人再确认一次：批准与回滚改的是正式策略文件，明天盘前起按新打法出信号。
 * 失败的原因（提案作废、文件被手改过）原样显示，不吞。
 */
type Action = { action: "approve"; id: number } | { action: "reject"; id: number; note?: string } | { action: "rollback"; note?: string };

async function post(body: Action): Promise<string | null> {
  const r = await fetch("/api/shadow", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (r.ok) return null;
  const j = await r.json().catch(() => null);
  return (j && (j.error ?? j.message)) || `HTTP ${r.status}`;
}

function useRun() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const run = async (confirmText: string, body: Action) => {
    if (!window.confirm(confirmText)) return;
    setBusy(true); setMsg(null);
    const e = await post(body);
    setBusy(false);
    if (e) setMsg(e); else router.refresh();
  };
  return { busy, msg, run };
}

const btn = "px-2 py-0.5 rounded-sm border text-[12px] disabled:opacity-50";

export function PendingActions({ id, from, to }: { id: number; from: string; to: string }) {
  const { busy, msg, run } = useRun();
  return (
    <span className="inline-flex items-center gap-2">
      <button className={`${btn} border-up/60 text-up`} disabled={busy}
        onClick={() => run(`批准切换 #${id}：${from} → ${to}？\n会改写策略文件的槽位段并升版本号，明天盘前计划起生效。`, { action: "approve", id })}>
        批准
      </button>
      <button className={`${btn} border-line-2 text-ink-2`} disabled={busy}
        onClick={() => {
          const note = window.prompt("否决理由（可空）") ?? undefined;
          void run(`否决切换 #${id}？该组合要再攒 20 个交易日新样本才重新参评。`, { action: "reject", id, ...(note ? { note } : {}) });
        }}>
        否决
      </button>
      {msg ? <span className="text-danger text-[11px]">{msg}</span> : null}
    </span>
  );
}

export function RollbackButton({ from, to }: { from: string; to: string }) {
  const { busy, msg, run } = useRun();
  return (
    <span className="inline-flex items-center gap-2">
      <button className={`${btn} border-warn/60 text-warn`} disabled={busy}
        onClick={() => run(`回滚最近一次切换：${from} → ${to}？\n版本号照样往前升；回滚后自动切换暂停，要你重新批 2 次才恢复。`, { action: "rollback" })}>
        回滚上一次切换
      </button>
      {msg ? <span className="text-danger text-[11px]">{msg}</span> : null}
    </span>
  );
}
