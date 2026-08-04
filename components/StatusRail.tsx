import Link from "next/link";
import type { SystemStatus } from "@/lib/ui/status";
import type { HealthVerdict } from "@/lib/ui/derive";
import { fmtAge, fmtTs } from "@/lib/ui/format";

/**
 * 全站状态条 + 硬告警。挂在 layout 上，每一页都看得见。
 *
 * spec §18.2 要求"调度失败必须告警，不可静默"，而**不可回补的缺口**是这套系统里
 * 唯一无法事后补救的损失（分钟线/涨停池/板块榜没有历史接口）。
 * 所以它不进详情抽屉，直接横在页面最上面，红底。
 */

const HEALTH_LABEL: Record<HealthVerdict, string> = {
  ok: "正常",
  failing: "高失败率",
  stale: "陈旧",
  down: "掉线",
};

function healthTone(v: HealthVerdict): string {
  if (v === "ok") return "text-down";
  if (v === "failing") return "text-warn";
  return "text-danger";
}

export function StatusRail({ s }: { s: SystemStatus }) {
  return (
    <>
      {s.gapsUnrecoverable.length > 0 ? (
        <div className="border-b border-danger bg-danger/10 px-3 py-1.5">
          <span className="text-danger font-medium">
            不可回补缺口 {s.gapsUnrecoverable.length} 条
          </span>
          <span className="ml-2 text-ink-2">
            分钟线 / 截面数据缺一天永久缺一天，回测覆盖率与情绪因子会永久带这个洞。
          </span>
          <span className="ml-2 text-ink-3 text-[11px]">
            最近：
            {s.gapsUnrecoverable
              .slice(0, 3)
              .map((g) => `${g.date} ${g.kind}`)
              .join(" / ")}
          </span>
          <Link href="/settings" className="ml-2 text-info underline">
            查看全部
          </Link>
        </div>
      ) : null}

      {s.quoteStale ? (
        <div className="border-b border-warn bg-warn/10 px-3 py-1.5">
          <span className="text-warn font-medium">行情快照陈旧</span>
          <span className="ml-2 text-ink-2">
            最新快照 {fmtTs(s.quoteTs, true)}（{fmtAge(s.quoteAgeMinutes)}）
            {s.inSession ? "，当前是交易时段，采集可能已停" : ""}。
            界面上的现价、距离买点、浮盈亏都基于这个时点，别当实时价用。
          </span>
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-line bg-panel px-3 py-1 text-[11px]">
        <span className="text-ink-3">
          快照
          <span className="num ml-1 text-ink">{fmtTs(s.quoteTs, true)}</span>
          <span className="ml-1 text-ink-3">({fmtAge(s.quoteAgeMinutes)})</span>
        </span>
        <span className="text-ink-3">
          时段
          <span className={`ml-1 ${s.inSession ? "text-up" : "text-ink-2"}`}>
            {s.inSession ? "交易中" : "非交易时段"}
          </span>
        </span>
        <span className="text-ink-3">
          执行模式
          <span className="ml-1 text-ink">{s.executionMode === "paper" ? "paper 模拟" : "manual 手工"}</span>
          <span className="ml-1 text-ink-3">· 不自动下单</span>
        </span>
        <span className="text-ink-3">
          源健康
          {s.worstHealth ? (
            <span className={`ml-1 ${healthTone(s.worstHealth)}`}>
              {HEALTH_LABEL[s.worstHealth]}
            </span>
          ) : (
            <span className="ml-1 text-ink-3">无记录</span>
          )}
          <span className="ml-1 text-ink-3">({s.health.length} 源)</span>
        </span>
        {s.gapsRecoverable.length > 0 ? (
          <span className="text-ink-3">
            可回补缺口<span className="num ml-1 text-warn">{s.gapsRecoverable.length}</span>
          </span>
        ) : null}
        <Link href="/settings" className="ml-auto text-info">
          源健康 / 调度 / 缺口明细 →
        </Link>
      </div>
    </>
  );
}

/** 源健康明细表。设置页用，也可放在作战台底部 */
export function SourceHealthTable({ s }: { s: SystemStatus }) {
  if (s.health.length === 0) {
    return <p className="text-ink-3">source_health 表为空 —— 采集 job 还没跑过。</p>;
  }
  return (
    <div className="overflow-x-auto">
      <table className="dense">
        <thead>
          <tr>
            <th>数据源</th>
            <th>状态</th>
            <th className="text-right">最后一次</th>
            <th className="text-right">距今</th>
            <th className="text-right">24h 成功率</th>
            <th className="text-right">样本</th>
            <th className="text-right">平均延迟</th>
            <th>最后错误</th>
          </tr>
        </thead>
        <tbody>
          {s.health.map((h) => (
            <tr key={h.source}>
              <td className="text-ink">{h.source}</td>
              <td className={healthTone(h.verdict)}>{HEALTH_LABEL[h.verdict]}</td>
              <td className="num">{fmtTs(h.lastTs, true)}</td>
              <td className="num text-ink-2">{fmtAge(h.ageMinutes)}</td>
              <td className="num">
                {h.okRate === null ? "—" : `${(h.okRate * 100).toFixed(0)}%`}
              </td>
              <td className="num text-ink-2">{h.windowN}</td>
              <td className="num text-ink-2">
                {h.avgLatencyMs === null ? "—" : `${Math.round(h.avgLatencyMs)}ms`}
              </td>
              <td className="text-ink-3 max-w-[28rem] truncate" title={h.lastErr ?? ""}>
                {h.lastErr ?? "—"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
