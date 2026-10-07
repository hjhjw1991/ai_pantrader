"use client";

import { useState } from "react";
import type { BacktestReport, SweepReport } from "@/lib/contracts/backtest";
import { BacktestReportView } from "@/components/BacktestReportView";
import { useArchiveRefresh, useArchiveRows } from "@/components/ArchiveSync";
import { NoRows } from "@/components/EmptyState";
import { Panel } from "@/components/Panel";
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
  // 刷新走 ArchiveSync 里那一份实现：删档、跑完回测、扫完参数是同一段逻辑，
  // 而不是这里抄一遍 —— 两处各写一份，迟早有一份落后于另一份
  const { refresh, refreshing } = useArchiveRefresh();
  const shown = useArchiveRows(serverRows);
  const [openId, setOpenId] = useState<string | null>(null);
  const [report, setReport] = useState<BacktestReport | null>(null);
  const [sweep, setSweep] = useState<SweepReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<{ kind: "ok" | "warn"; text: string } | null>(null);
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
   * 删完立刻 refresh（先重画表格、再对齐服务端），和跑完回测时走的是同一段代码。
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

      // 列表没取到也如实说一句：整页 refresh 仍会发起，最终会对齐，
      // 但"已删除"这句话不能建立在没拿到的列表上
      setNote(
        await refresh()
          ? { kind: "ok", text: "已删除" }
          : { kind: "warn", text: "已删除，但列表没取到 —— 刷新页面可见" }
      );
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false); setDeletingId(null);
    }
  }

  const pct = (v: number | null) => (v === null ? "—" : `${(v * 100).toFixed(1)}%`);

  return (
    <Panel
      title="回测存档"
      hint="报告不再只活在页面里 —— 四年跨度一次回测约 6 分钟，36 点扫描约 3.7 小时，切走就没了太贵"
      // 份数跟着 shown 走而不是服务端那份：删完/跑完立刻就变，
      // 不然标题写着 0 份而下面躺着一行，人不知道该信哪个
      right={`最近 ${shown.length} 份 / 上限 ${keep}`}
    >
      <div className="flex flex-col gap-2">
        {shown.length === 0 ? (
          <NoRows what="还没有存档" hint="跑一次回测或参数扫描，结果会自动存下来" />
        ) : (
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
        )}

        {/* 删除成功但服务端还在重渲染时也要有话讲：这中间几秒界面上什么都没变，
            不写"刷新中…"的话，看上去和删除失败没有区别 */}
        {err !== null ? (
          <span className="text-danger text-[11px]">{err}</span>
        ) : refreshing ? (
          <span className="text-ink-3 text-[11px]">
            {note !== null ? `${note.text} · ` : ""}刷新中…
          </span>
        ) : note !== null ? (
          <span className={`text-[11px] ${note.kind === "ok" ? "text-down" : "text-warn"}`}>
            {note.text}
          </span>
        ) : null}

        <p className="text-ink-3 text-[11px]">
          只留最近 {keep} 份，超出的从旧到新自动删。报告是不可变快照：
          参数改过之后重跑给不出同一个答案，所以它进 .ptbak 备份。
        </p>

        {report !== null ? <BacktestReportView report={report} /> : null}
      {sweep !== null ? (
        <div className="flex flex-col gap-1">
          <p className="text-ink-2 text-[12px]">
            扫描存档：扫了 {sweep.evaluated} 个点，最优 Calmar{" "}
            <span className="num">{sweep.best.metrics.calmar.toFixed(2)}</span>
            {" "}@ {JSON.stringify(sweep.best.params)}
          </p>
          {/* 去水成绩是后补的字段，老存档里没有 —— 如实说"这份没算过"，
              不拿 0 冒充"成绩全是运气"，也不干脆不提 */}
          {sweep.selection === undefined ? (
            <p className="text-ink-3 text-[11px]">
              这份存档跑在选择偏差校正之前，没有去水成绩。
            </p>
          ) : (
            <p className={sweep.selection.overfitSuspected ? "text-danger text-[11px]" : "text-ink-3 text-[11px]"}>
              去水后 <span className="num">{sweep.selection.deflated.toFixed(2)}</span>：{sweep.selection.note}
            </p>
          )}
        </div>
      ) : null}
      </div>
    </Panel>
  );
}
