import Link from "next/link";
import type { SystemStatus } from "@/lib/ui/status";
import { fmtAge, fmtTs } from "@/lib/ui/format";
import { LiveBar } from "@/components/LiveBar";

/**
 * 顶栏：数据时点、时段、告警徽标、实时控件与通知铃。
 *
 * 不可回补缺口（spec §18.2 "调度失败必须告警，不可静默"）从整条红横幅收成红色徽标：
 * 它仍然一直在视野里、点开就是明细，只是不再占掉一整行 —— 那一行在作战台上天天都在，
 * 天天都在的横幅很快就会被人眼过滤掉，徽标反而更像告警。行情陈旧同理。
 */
export function TopBar({ s }: { s: SystemStatus }) {
  const unrec = s.gapsUnrecoverable.length, rec = s.gapsRecoverable.length;
  return (
    <header className="h-12 shrink-0 flex items-center gap-3 px-4 border-b border-line bg-panel text-[12px]">
      <span className="text-ink-3">快照 <span className="num text-ink">{fmtTs(s.quoteTs, true)}</span> <span className="text-ink-3">({fmtAge(s.quoteAgeMinutes)})</span></span>
      <span className={`px-1.5 py-0.5 rounded-sm text-[11px] ${s.inSession ? "bg-up/15 text-up" : "bg-panel-2 text-ink-2"}`}>{s.inSession ? "交易中" : "非交易时段"}</span>
      {s.quoteStale ? (
        <span className="px-1.5 py-0.5 rounded-sm text-[11px] bg-warn/15 text-warn" title="界面上的现价、距离买点、浮盈亏都基于这个时点，别当实时价用">行情陈旧</span>
      ) : null}
      {unrec > 0 ? (
        <Link href="/settings" scroll={false} className="px-1.5 py-0.5 rounded-sm text-[11px] bg-danger/15 text-danger hover:bg-danger/25"
          title={`分钟线 / 截面数据缺一天永久缺一天。最近：${s.gapsUnrecoverable.slice(0, 3).map(g => `${g.date} ${g.kind}`).join(" / ")}`}>
          不可回补缺口 {unrec}
        </Link>
      ) : null}
      {rec > 0 ? (
        <Link href="/settings" scroll={false} className="px-1.5 py-0.5 rounded-sm text-[11px] bg-warn/10 text-warn hover:bg-warn/20">可回补 {rec}</Link>
      ) : null}
      <span className="ml-auto" />
      <LiveBar />
    </header>
  );
}
