"use client";

import { useState } from "react";
import type { BacktestReport } from "@/lib/contracts/backtest";
import { BacktestReportView } from "@/components/BacktestReportView";
import { DateInput } from "@/components/DateInput";

/**
 * 回测执行控件。只在回测层就绪时才被渲染（见 lab 页）。
 *
 * 失败时把后端原因原样显示，不退化成"暂无数据" —— 回测跑失败和回测跑出空结果
 * 是两件事，后者才可能意味着策略在该区间没交易。
 */
export function LabRunner({
  strategies,
  defaultRange,
}: {
  strategies: Array<{ id: string; version: string }>;
  defaultRange: { from: string; to: string };
}) {
  const [strategyId, setStrategyId] = useState(strategies[0]?.id ?? "");
  const [from, setFrom] = useState(defaultRange.from);
  const [to, setTo] = useState(defaultRange.to);
  // 初始资金没有默认值：它决定手数取整能不能成交、单票占比是多少。
  // 替用户假设账户规模会让成交笔数与占比全都偏。
  const [cash, setCash] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [report, setReport] = useState<BacktestReport | null>(null);

  const inputCls = "num bg-panel-2 border border-line-2 rounded-sm px-2 py-1 text-ink";

  return (
    <div className="flex flex-col gap-3">
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setErr(null);
          setReport(null);
          try {
            const r = await fetch("/api/backtest", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ strategyId, from, to, initialCash: Number(cash) }),
            });
            const j = await r.json().catch(() => ({}));
            if (!r.ok) throw new Error(j?.error ?? `HTTP ${r.status}`);
            setReport(j.report as BacktestReport);
          } catch (e2) {
            setErr((e2 as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <label className="flex flex-col gap-0.5">
          <span className="text-ink-3 text-[11px]">策略</span>
          <select
            className={`${inputCls} w-40`}
            value={strategyId}
            onChange={(e) => setStrategyId(e.target.value)}
            required
          >
            {strategies.map((s) => (
              <option key={`${s.id}-${s.version}`} value={s.id}>
                {s.id} @ {s.version}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-0.5">
          <span className="text-ink-3 text-[11px]">起始日</span>
          {/* 上下界卡在库里真有交易日历的区间；再用 to 卡住 from，反过来的区间在控件上就选不出来 */}
          <DateInput
            className="w-36"
            value={from}
            onChange={setFrom}
            min={defaultRange.from}
            max={to || defaultRange.to}
            required
          />
        </label>
        <label className="flex flex-col gap-0.5">
          <span className="text-ink-3 text-[11px]">结束日</span>
          <DateInput
            className="w-36"
            value={to}
            onChange={setTo}
            min={from || defaultRange.from}
            max={defaultRange.to}
            required
          />
        </label>
        <label className="flex flex-col gap-0.5">
          <span className="text-ink-3 text-[11px]">初始资金（元，必填）</span>
          <input
            className={`${inputCls} w-32`}
            value={cash}
            onChange={(e) => setCash(e.target.value)}
            inputMode="numeric"
            placeholder="必填"
            required
          />
        </label>
        <button
          type="submit"
          className="border border-line-2 rounded-sm px-3 py-1 text-ink-2 hover:text-ink disabled:opacity-40"
          disabled={busy || !strategyId || !(Number(cash) > 0)}
        >
          {busy ? "回放中…" : "开始回测"}
        </button>
        {err ? <span className="text-danger">{err}</span> : null}
      </form>

      {report ? <BacktestReportView report={report} /> : null}
    </div>
  );
}
