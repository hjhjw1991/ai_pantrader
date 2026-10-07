"use client";

import { useEffect, useState, useTransition } from "react";
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
export function ReportArchive({ rows: serverRows, keep }: { rows: ReportSummary[]; keep: number }) {
  const router = useRouter();
  // router.refresh() 返回 void，等不到它完成 —— 只有 useTransition 的 pending
  // 能告诉我服务端重渲染还在路上（同 components/forms.tsx 的 useSubmit）
  const [refreshing, startTransition] = useTransition();
  const [openId, setOpenId] = useState<string | null>(null);
  const [report, setReport] = useState<BacktestReport | null>(null);
  const [sweep, setSweep] = useState<SweepReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  /**
   * 删完之后表格立刻要变，而整页 refresh 要重算四年的行数快照（实测 2~8 秒）。
   * 所以先问一次列表接口把表格重画出来，再让 refresh 把服务端那边
   * （面板上的"最近 N 份"计数、其它面板）对齐。
   *
   * 这不是第二份状态：它只在 refresh 落地之前存在，服务端的新 props 一到就作废。
   */
  const [rows, setRows] = useState<ReportSummary[] | null>(null);
  useEffect(() => setRows(null), [serverRows]);
  const shown = rows ?? serverRows;
  // 删除请求在飞、或服务端重渲染还在路上，按钮都不该重新可点
  const working = busy || refreshing;

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

  /**
   * 删除是**阻塞**的：await 到 DELETE 的响应才继续，而那个响应是服务端同步写完之后才发的
   * —— 所以走到下一行时，这份存档在库里已经没了，不存在"删到一半"的中间态。
   *
   * 回到前端紧接着做两件事，顺序不能反：先把表格重画（人立刻看见那一行没了），
   * 再刷新服务端。反过来做的话，画面上会有一段时间"删除已成功但列表没动"，
   * 看起来和失败一模一样。
   */
  async function remove(row: ReportSummary) {
    const id = row.id;
    // 删了就是真没了：报告是不可变快照，四年跨度重跑约 6 分钟，36 点扫描约 3.7 小时
    const label = `${row.ts.slice(5, 19)} ${row.strategyId}@${row.strategyVersion} ${row.from} → ${row.to}`;
    if (!window.confirm(`删除这份存档？\n${label}\n\n删掉只能重跑，不会自动回来。`)) return;

    setBusy(true); setDeletingId(id); setErr(null); setNote(null);
    try {
      const r = await fetch(`/api/backtest/reports?id=${encodeURIComponent(id)}`, { method: "DELETE" });
      const j = await r.json().catch(() => ({}));
      // 服务端没删到就如实报错（比如这份已经被删过了），不拿"已删除"糊过去
      if (!r.ok) throw new Error(j?.error ?? `HTTP ${r.status}`);

      if (openId === id) { setOpenId(null); setReport(null); setSweep(null); }

      const lr = await fetch("/api/backtest/reports");
      const lj = await lr.json().catch(() => null);
      // 列表没取到就退回等整页刷新，绝不拿空数组冒充"删空了"
      if (lr.ok && Array.isArray(lj?.rows)) setRows(lj.rows as ReportSummary[]);
      setNote("已删除");

      startTransition(() => router.refresh());
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false); setDeletingId(null);
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
            {shown.map((r) => (
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
                    disabled={working}
                    onClick={() => void open(r.id)}
                  >
                    {openId === r.id ? "收起" : "查看"}
                  </button>
                  <button
                    className="ml-2 text-ink-3 hover:text-danger disabled:opacity-40"
                    disabled={working}
                    onClick={() => void remove(r)}
                    title="删掉这份存档（不可恢复，只能重跑）"
                  >
                    {deletingId === r.id ? "删除中…" : "删除"}
                  </button>
                  {/* 扫描报告的 JSON 结构不同，导不出来 —— 压根不给入口，比点了再报错好 */}
                  {r.kind === "backtest" ? (
                    <a
                      className="ml-2 text-info hover:underline"
                      href={`/api/backtest/report-html?id=${encodeURIComponent(r.id)}`}
                      title="下载一份自包含 HTML：图表是内联 SVG，不带任何外部请求"
                    >
                      导出
                    </a>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {shown.length === 0 ? (
        <p className="text-ink-3 text-[12px]">存档已清空，跑一次回测或参数扫描会自动存下来。</p>
      ) : null}

      {/* 删除成功但服务端还在重渲染时也要有话讲：这中间几秒界面上什么都没变，
          不写"刷新中…"的话，看上去和删除失败没有区别 */}
      {err !== null ? (
        <span className="text-danger text-[11px]">{err}</span>
      ) : refreshing ? (
        <span className="text-ink-3 text-[11px]">{note !== null ? `${note} · ` : ""}刷新中…</span>
      ) : note !== null ? (
        <span className="text-down text-[11px]">{note}</span>
      ) : null}

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
