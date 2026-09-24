import type { StockAdvice } from "@/lib/contracts/strategy";
import { Num } from "@/components/Num";
import { Tag } from "@/components/Panel";
import { NoRows } from "@/components/EmptyState";
import { ChartLink } from "@/components/ChartLink";

/**
 * 持仓 / 观察池的逐只建议。
 *
 * 两列分开摆：左边"动作"是结论（持仓 = 纪律，观察 = 正式评估），
 * 右边"技术面"是参考，颜色区分正负面。人一眼要能分清哪个是必须照做的、哪个是提醒。
 */

function ActionCell({ a }: { a: StockAdvice }) {
  const t = a.action;
  const tone = t === "清仓" || t === "减仓" ? "down" : t.startsWith("可买") || t === "今日候选" || t === "加仓" ? "up" : t === "不买" ? "muted" : "warn";
  return <Tag tone={tone as any}>{t}</Tag>;
}

const LEAN_TONE: Record<string, string> = { 持有: "text-ink-2", 留意: "text-warn", 考虑减仓: "text-down" };
const HINT_TONE: Record<string, string> = { 正面: "text-up", 负面: "text-down", 中性: "text-ink-2" };

export function AdviceTable({ rows, kind, emptyWhat, emptyHint }: {
  rows: StockAdvice[]; kind: "持仓" | "观察"; emptyWhat: string; emptyHint?: string;
}) {
  const list = rows.filter(r => r.kind === kind);
  if (list.length === 0) return <NoRows what={emptyWhat} hint={emptyHint} />;
  return (
    <div className="overflow-x-auto">
      <table className="dense">
        <thead>
          <tr>
            <th>代码</th>
            <th>名称</th>
            <th>{kind === "持仓" ? "纪律动作" : "今日判定"}</th>
            {kind === "持仓" ? <th title="技术面倾向，参考用，不覆盖纪律动作">技术面倾向</th> : null}
            <th className="text-right">{kind === "持仓" ? "参考价" : "触发价"}</th>
            <th className="text-right">止损价</th>
            {kind === "观察" ? <th className="text-right">目标价</th> : null}
            {kind === "观察" ? <th className="text-right">盈亏比</th> : null}
            <th>日 / 周 MACD</th>
            <th className="text-right">阻力 / 支撑</th>
            <th>理由</th>
            <th>技术面提示（参考）</th>
          </tr>
        </thead>
        <tbody>
          {list.map(a => (
            <tr key={`${a.kind}-${a.code}`}>
              <td className="num text-ink">
                {a.code}
                <ChartLink code={a.code} levels={{ trigger: a.triggerPx, stop: a.stopPx, target: a.targetPx }} />
              </td>
              <td>{a.name ?? "—"}</td>
              <td><ActionCell a={a} /></td>
              {kind === "持仓" ? <td className={LEAN_TONE[a.lean ?? ""] ?? "text-ink-3"}>{a.lean ?? "—"}</td> : null}
              <td className="num"><Num v={a.triggerPx} /></td>
              <td className="num"><Num v={a.stopPx} /></td>
              {kind === "观察" ? (
                <td className="num"><Num v={a.targetPx} />{a.targetRef && a.targetPx !== null ? <span className="ml-1 text-ink-3 text-[10px]">参考</span> : null}</td>
              ) : null}
              {kind === "观察" ? (
                <td className={`num ${a.rrRatio !== null && a.rrRatio < 1.5 ? "text-warn" : ""}`}>{a.rrRatio === null ? "—" : a.rrRatio.toFixed(2)}</td>
              ) : null}
              <td className="text-ink-2">{a.tech.daily ?? "—"} / {a.tech.weekly ?? "—"}</td>
              <td className="num text-ink-2">
                {a.tech.resistance === null ? "—" : a.tech.resistance.toFixed(2)} / {a.tech.support === null ? "—" : a.tech.support.toFixed(2)}
              </td>
              <td className="text-ink-2 max-w-[22rem] truncate" title={a.reasons.join("；")}>{a.reasons.join("；") || "—"}</td>
              <td className="max-w-[26rem]">
                {a.tech.hints.length === 0 ? <span className="text-ink-3">—</span> : (
                  <span className="flex flex-col gap-0.5">
                    {a.tech.hints.map((h, i) => <span key={i} className={`${HINT_TONE[h.tone]} text-[12px]`}>{h.text}</span>)}
                  </span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
