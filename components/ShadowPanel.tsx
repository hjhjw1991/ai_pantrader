import type { ShadowView } from "@/lib/ui/adapters/overview";
import type { VariantReport } from "@/lib/shadow/report";
import { Tag } from "@/components/Panel";
import { NoRows } from "@/components/EmptyState";
import { PendingActions, RollbackButton } from "@/components/ShadowActions";

/**
 * 影子盘看板：各组合实盘 / 回放成绩、离毕业还差什么、待批提案、切换历史。
 *
 * 实盘与回放分两张表，不合并：回放是在已知结局的行情上跑调好的参数，只排座次、不算毕业。
 * 并在一起，回放的几千笔会把实盘那几十笔淹没，排行看起来就是回放的排行。
 */

const pct = (x: number | null | undefined, d = 2) => (x === null || x === undefined ? "—" : `${x >= 0 ? "+" : ""}${x.toFixed(d)}%`);
const ratio = (x: number | null | undefined) => (x === null || x === undefined ? "—" : `${(x * 100).toFixed(0)}%`);
const dir = (x: number | null | undefined) => (x === null || x === undefined ? "" : x > 0 ? "text-up" : x < 0 ? "text-down" : "");

function ReportTable({ rows, incumbent, showDays }: { rows: VariantReport[]; incumbent: string | null; showDays: boolean }) {
  const sorted = [...rows].sort((a, b) => (b.summary.meanNet ?? -Infinity) - (a.summary.meanNet ?? -Infinity));
  return (
    <div className="overflow-x-auto">
      <table className="dense">
        <thead>
          <tr>
            <th>组合</th>
            {showDays ? <th className="text-right">交易日</th> : null}
            <th className="text-right">已结算</th>
            <th className="text-right">触发率</th>
            <th className="text-right">胜率</th>
            <th className="text-right">期望/笔</th>
            <th className="text-right">盈亏比</th>
            <th className="text-right">最大回撤</th>
            <th className="text-right">对 baseline</th>
            <th className="text-right">t</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map(v => (
            <tr key={v.id} className={v.status !== "active" ? "opacity-50" : ""}>
              <td>
                <span className="text-ink">{v.name}</span>
                {v.id === incumbent ? <span className="ml-1"><Tag tone="info">正式</Tag></span> : null}
                {v.status !== "active" ? <span className="ml-1"><Tag>已退役</Tag></span> : null}
              </td>
              {showDays ? <td className="num">{v.days}</td> : null}
              <td className="num">{v.summary.settled}</td>
              <td className="num">{ratio(v.summary.triggerRate)}</td>
              <td className="num">{ratio(v.summary.winRate)}</td>
              <td className={`num ${dir(v.summary.meanNet)}`}>{pct(v.summary.meanNet)}</td>
              <td className="num">{v.summary.payoff?.toFixed(2) ?? "—"}</td>
              <td className="num">{v.summary.maxDrawdown === null ? "—" : `${v.summary.maxDrawdown.toFixed(1)}`}</td>
              <td className={`num ${dir(v.vsBaseline?.diff)}`}>{v.vsBaseline ? pct(v.vsBaseline.diff) : "—"}</td>
              <td className={`num ${v.vsBaseline && Math.abs(v.vsBaseline.t) >= 2 ? "text-warn" : ""}`}>{v.vsBaseline?.t.toFixed(2) ?? "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function ShadowPanelBody({ v }: { v: ShadowView }) {
  const st = v.status;
  const lastApplied = st?.history.find(h => h.status === "applied" && h.kind === "switch"
    && !st.history.some(r => r.kind === "rollback" && r.status === "applied" && r.reverts === h.id));
  return (
    <div className="flex flex-col gap-3">
      {/* 在任 + 待批 */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        {st ? (
          <>
            <span className="text-ink-2">正式组合 <span className="text-ink">{st.incumbent ?? "（槽位未登记为变体）"}</span></span>
            <span className="text-ink-2">策略 <span className="num text-ink">{st.strategyId}@{st.version}</span></span>
            <span className="text-ink-2">自动切换{" "}
              {st.autoAllowed ? <Tag tone="warn">已开启</Tag> : <span className="text-ink">未开启（再人批 {st.approvalsUntilAuto} 次）</span>}
            </span>
            {lastApplied ? <span className="ml-auto"><RollbackButton from={lastApplied.toVariant ?? "?"} to={lastApplied.fromVariant ?? "?"} /></span> : null}
          </>
        ) : (
          <span className="text-warn">切换状态读不出来：{v.statusError}</span>
        )}
      </div>

      {st?.pending ? (
        <div className="border border-warn/60 bg-warn/5 rounded-sm px-3 py-2">
          <div className="flex flex-wrap items-center gap-3">
            <span className="text-warn font-medium">待批切换 #{st.pending.id}</span>
            <span className="text-ink">{st.pending.fromVariant} → {st.pending.toVariant}</span>
            <PendingActions id={st.pending.id} from={st.pending.fromVariant ?? "?"} to={st.pending.toVariant ?? "?"} />
          </div>
          {st.pending.evidence ? (
            <p className="mt-1 text-[12px] text-ink-2">
              {st.pending.evidence.days} 个共同交易日、{st.pending.evidence.settled} 笔：期望 {pct(st.pending.evidence.meanNet)}/笔
              对在任 {pct(st.pending.evidence.incumbentMean)}，t = {st.pending.evidence.t?.toFixed(2) ?? "—"}，
              最大回撤 {st.pending.evidence.maxDrawdown?.toFixed(1) ?? "—"} 对 {st.pending.evidence.incumbentMaxDrawdown?.toFixed(1) ?? "—"}
            </p>
          ) : null}
        </div>
      ) : null}

      {/* 毕业进度 */}
      {st && st.board.length > 0 ? (
        <div>
          <div className="text-ink-2 mb-1">
            毕业进度 <span className="text-ink-3 text-[11px]">只看实盘样本，与正式组合共同结清的交易日上比：≥30 笔、≥20 天、期望更高且 t ≥ 2、回撤不更深</span>
          </div>
          <ul className="flex flex-col gap-1 text-[12px]">
            {st.board.map(g => {
              const prog = Math.min(1, g.settled / 30) * 0.5 + Math.min(1, g.days / 20) * 0.5;
              return (
                <li key={g.variant} className="flex items-center gap-2">
                  <span className="w-44 shrink-0 truncate text-ink" title={g.variant}>{g.name}</span>
                  <span className="w-28 h-1.5 bg-panel-2 rounded-sm overflow-hidden shrink-0" title="样本积累进度（笔数与天数各占一半）">
                    <span className={`block h-full ${g.passed ? "bg-up" : "bg-info/70"}`} style={{ width: `${Math.round(prog * 100)}%` }} />
                  </span>
                  <span className="num text-ink-2 w-24 shrink-0">{g.days} 天 {g.settled} 笔</span>
                  {g.passed ? <Tag tone="up">过线</Tag> : <span className="text-ink-3 truncate" title={g.failures.join("；")}>{g.failures.join("；")}</span>}
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}

      <div>
        <div className="text-ink-2 mb-1">实盘影子 <span className="text-ink-3 text-[11px]">每天 09:15 随盘前计划记录，按止损 / 目标价模拟离场，扣双边成本</span></div>
        {v.live.every(r => r.days === 0) ? (
          <NoRows what="还没有实盘影子样本" hint="盘前计划每天自动记录；第一批结算要等持有期（5 个交易日）走完" />
        ) : <ReportTable rows={v.live} incumbent={st?.incumbent ?? null} showDays />}
      </div>

      <details>
        <summary className="cursor-pointer text-ink-2">
          冷启动回放 <span className="text-ink-3 text-[11px]">在已知结局的历史上跑，只排座次、不算毕业</span>
        </summary>
        <div className="mt-1">
          {v.replay.every(r => r.summary.settled === 0)
            ? <NoRows what="没有回放样本" hint="pnpm shadow:replay 跑一次冷启动回放" />
            : <ReportTable rows={v.replay} incumbent={st?.incumbent ?? null} showDays={false} />}
        </div>
      </details>

      {st && st.history.length > 0 ? (
        <details>
          <summary className="cursor-pointer text-ink-2">切换历史（{st.history.length}）</summary>
          <ul className="mt-1 text-[12px] text-ink-2 flex flex-col gap-0.5">
            {st.history.map(h => (
              <li key={h.id}>
                <span className="num text-ink-3">#{h.id}</span>{" "}
                {h.kind === "rollback" ? "回滚" : "切换"} · {h.status} · {h.fromVariant} → {h.toVariant}
                {h.decidedBy ? `（${h.decidedBy === "human" ? "人批" : "自动"}）` : ""} · {h.proposedAt.slice(0, 10)}
                {h.toVersion ? <span className="num"> · {h.fromVersion} → {h.toVersion}</span> : null}
                {h.note ? <span className="text-ink-3"> · {h.note}</span> : null}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}

/**
 * 作战台顶部的影子盘摘要：正式组合、自动切换状态、待批提案（可直接批）、离毕业最近的两个挑战者。
 * 完整成绩单在「影子盘」抽屉里。
 */
export function ShadowSummary({ v }: { v: ShadowView }) {
  const st = v.status;
  if (st === null) return <span className="text-warn text-[12px]">切换状态读不出来：{v.statusError}</span>;
  const top = st.board.slice(0, 3);
  const liveDays = Math.max(0, ...v.live.map(r => r.days));
  return (
    <div className="flex flex-col gap-2 text-[12px]">
      <div className="flex flex-wrap gap-x-3 gap-y-1 text-ink-2">
        <span>正式组合 <span className="text-ink">{st.incumbent ?? "（未登记）"}</span></span>
        <span>自动切换 {st.autoAllowed ? <Tag tone="warn">已开启</Tag> : <span className="text-ink">再人批 {st.approvalsUntilAuto} 次</span>}</span>
        <span>实盘样本 <span className="num text-ink">{liveDays}</span> 天</span>
      </div>
      {st.pending ? (
        <div className="border border-warn/60 bg-warn/5 rounded-sm px-2 py-1 flex flex-wrap items-center gap-2">
          <span className="text-warn">待批 #{st.pending.id}</span>
          <span className="text-ink">{st.pending.fromVariant} → {st.pending.toVariant}</span>
          {st.pending.evidence ? <span className="text-ink-2">t = {st.pending.evidence.t?.toFixed(2) ?? "—"}，{st.pending.evidence.settled} 笔</span> : null}
          <PendingActions id={st.pending.id} from={st.pending.fromVariant ?? "?"} to={st.pending.toVariant ?? "?"} />
        </div>
      ) : <span className="text-ink-3">没有待批的切换</span>}
      <ul className="flex flex-col gap-1">
        {top.map(g => {
          const prog = Math.min(1, g.settled / 30) * 0.5 + Math.min(1, g.days / 20) * 0.5;
          return (
            <li key={g.variant} className="flex items-center gap-2">
              <span className="w-36 shrink-0 truncate text-ink" title={g.variant}>{g.name}</span>
              <span className="flex-1 h-1.5 bg-panel-2 rounded-sm overflow-hidden" title="样本积累进度（笔数与天数各占一半）">
                <span className={`block h-full ${g.passed ? "bg-up" : "bg-info/70"}`} style={{ width: `${Math.round(prog * 100)}%` }} />
              </span>
              <span className="num text-ink-2 shrink-0">{g.days} 天 {g.settled} 笔</span>
              {g.passed ? <Tag tone="up">过线</Tag> : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
