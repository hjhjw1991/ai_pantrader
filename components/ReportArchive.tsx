"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { BacktestReport, SweepReport } from "@/lib/contracts/backtest";
import { BacktestReportView } from "@/components/BacktestReportView";
import type { ReportSummary } from "@/lib/ui/queries";

/**
 * 回测/扫描存档。
 *
 * 为什么值得一张表：报告原本只活在页面的 React state 里，切走就没了，
 * 而重算的代价是实打实的 —— 四年跨度的单次回测约 6 分钟，36 点扫描约 3.7 小时。
 *
 * 列表只显示摘要（服务端查询就没读整份 JSON），点开某一条才去取完整报告。
 */
export function ReportArchive({ rows, keep }: { rows: ReportSummary[]; keep: number }) {
  const router = useRouter();
  const [openId, setOpenId] = useState<string | null>(null);
  const [report, setReport] = useState<BacktestReport | null>(null);
  const [sweep, setSweep] = useState<SweepReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function open(id: string) {
    if (openId === id) { setOpenId(null); setReport(null); setSweep(null); return; }
    setBusy(true); setErr(null); setReport(null); setSweep(null);
    try {
      const r = await fetch(`/api/backtest/reports?id=${encodeURIComponent(id)}`);
      const j = await r.json();
      if (!r.ok) throw new Error(j?.error ?? `HTTP ${r.status}`);
      if (j.kind === "sweep") setSweep(j.report as SweepReport);
      else setReport(j.report as BacktestReport);
      setOpenId(id);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    setBusy(true); setErr(null);
    try {
      const r = await fetch(`/api/backtest/reports?id=${encodeURIComponent(id)}`, { method: "DELETE" });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j?.error ?? `HTTP ${r.status}`);
      if (openId === id) { setOpenId(null); setReport(null); setSweep(null); }
      router.refresh();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const pct = (v: number | null) => (v === null ? "—" : `${(v * 100).toFixed(1)}%`);

  return (
    <div className="flex flex-col gap-2">
      <div className="overflow-x-auto">
        <table className="dense">
          <thead>
            <tr>
              <th>跑于</th>
              <th>类型</th>
              <th>策略</th>
              <th>区间</th>
              <th className="text-right">年化</th>
              <th className="text-right">最大回撤</th>
              <th className="text-right">Calmar</th>
              <th className="text-right">成交</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className={openId === r.id ? "text-ink" : undefined}>
                <td className="num text-ink-3">{r.ts.slice(5, 19)}</td>
                <td>{r.kind === "sweep" ? `扫描 ${r.evaluated ?? "—"} 点` : "回测"}</td>
                <td className="text-ink-2">{r.strategyId}@{r.strategyVersion}</td>
                <td className="num text-ink-3">{r.from} → {r.to}</td>
                {/* 扫描没有单点指标，如实画破折号，不拿最优点的数字冒充整体 */}
                <td className="num">{pct(r.annualReturn)}</td>
                <td className="num">{pct(r.maxDrawdown)}</td>
                <td className="num">{r.calmar === null ? "—" : r.calmar.toFixed(2)}</td>
                <td className="num">{r.trades ?? "—"}</td>
                <td className="whitespace-nowrap">
                  <button
                    className="text-info hover:underline disabled:opacity-40"
                    disabled={busy}
                    onClick={() => void open(r.id)}
                  >
                    {openId === r.id ? "收起" : "查看"}
                  </button>
                  <button
                    className="ml-2 text-ink-3 hover:text-danger disabled:opacity-40"
                    disabled={busy}
                    onClick={() => void remove(r.id)}
                    title="删掉这份存档"
                  >
                    删除
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {err !== null ? <span className="text-danger text-[11px]">{err}</span> : null}

      <p className="text-ink-3 text-[11px]">
        只留最近 {keep} 份，超出的从旧到新自动删。报告是不可变快照：
        参数改过之后重跑给不出同一个答案，所以它进 .ptbak 备份。
      </p>

      {report !== null ? <BacktestReportView report={report} /> : null}
      {sweep !== null ? (
        <p className="text-ink-2 text-[12px]">
          扫描存档：扫了 {sweep.evaluated} 个点，最优 Calmar{" "}
          <span className="num">{sweep.best.metrics.calmar.toFixed(2)}</span>
          {" "}@ {JSON.stringify(sweep.best.params)}
        </p>
      ) : null}
    </div>
  );
}
