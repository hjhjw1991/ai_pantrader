"use client";

import { useEffect, useState } from "react";
import { Num } from "@/components/Num";
import { Tag } from "@/components/Panel";
import type { StockAnalysis, TrendVerdict } from "@/lib/ui/adapters/analyze";
import { fmtTs } from "@/lib/ui/format";

/**
 * 单票分析面板：**按需**取一份趋势读数与买卖点。
 *
 * 为什么要单独做这一块，而不是把信息塞进观察池表格的列里：
 * 表格是横向扫的（哪只最接近买点），分析是纵向读的（这一只到底什么情况）。
 * 硬塞进去只会得到一张 20 列的表，而抽屉比主区还窄。
 *
 * 面板里**不画任何自己发明的信号**：迷你走势上的水平线只有现价、结构位（因子给的
 * 支撑/阻力）、触发价与止损（引擎给的或我手填的）。图上随手加的箭头会被当成
 * 系统给的信号 —— 这是这套系统最容易亏钱的用法。
 */

const VERDICT_TONE: Record<TrendVerdict, "up" | "down" | "muted" | "warn"> = {
  多头: "up", 偏多: "up", 震荡: "muted", 偏空: "down", 空头: "down", 数据不足: "warn",
};

const HINT_TONE: Record<string, string> = {
  正面: "text-up", 负面: "text-down", 中性: "text-ink-2", 警告: "text-warn",
};

function Line({
  points, marks,
}: {
  points: number[];
  marks: Array<{ v: number | null; cls: string; label: string }>;
}) {
  const values = [...points, ...marks.map((m) => m.v).filter((v): v is number => v !== null)];
  if (values.length === 0) return null;
  const w = 260, h = 76, pad = 3;
  const min = Math.min(...values), max = Math.max(...values);
  const rng = max - min || 1;
  const x = (i: number) => pad + (i * (w - 2 * pad)) / Math.max(1, points.length - 1);
  const y = (v: number) => pad + (1 - (v - min) / rng) * (h - 2 * pad);
  const d = points.map((v, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  return (
    <svg viewBox={`0 0 ${w} ${h}`} width="100%" height={h} preserveAspectRatio="none" className="block">
      {marks.map((m) =>
        m.v === null ? null : (
          <line
            key={m.label}
            x1={0} x2={w} y1={y(m.v)} y2={y(m.v)}
            stroke="currentColor" strokeWidth={1} strokeDasharray="3 3"
            vectorEffect="non-scaling-stroke"
            className={m.cls}
          />
        )
      )}
      <path d={d} fill="none" stroke="currentColor" strokeWidth={1.5} vectorEffect="non-scaling-stroke" className="text-ink" />
    </svg>
  );
}

export function AnalyzePanel({ code, onClose }: { code: string; onClose?: () => void }) {
  const [data, setData] = useState<StockAnalysis | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setErr(null);
    fetch(`/api/signal/analyze?code=${encodeURIComponent(code)}`)
      .then(async (r) => {
        const j = await r.json();
        if (!r.ok) throw new Error(j?.error ?? `HTTP ${r.status}`);
        return j as StockAnalysis;
      })
      .then((j) => { if (alive) setData(j); })
      .catch((e: Error) => { if (alive) { setErr(e.message); setData(null); } })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [code]);

  if (loading) return <div className="px-3 py-2 text-ink-3 text-[11px]">分析中…（要跑一遍引擎，几秒）</div>;
  if (err !== null || data === null) {
    return (
      <div className="px-3 py-2 text-[11px]">
        <span className="text-danger">{err ?? "没有返回分析结果"}</span>
        {onClose ? (
          <button type="button" className="ml-2 text-ink-3 hover:text-ink" onClick={onClose}>收起</button>
        ) : null}
      </div>
    );
  }

  const t = data.trend;
  const p = data.plan;
  const lv = t.levels;
  const spark = t.spark.map((b) => b.c);

  return (
    <div className="px-3 py-2 flex flex-col gap-2 text-[11px]">
      <div className="flex items-baseline gap-2">
        <span className="num text-ink">{data.code}</span>
        <span className="text-ink">{data.name ?? "—"}</span>
        <span className="num text-ink">
          <Num v={data.price} />
        </span>
        <span className="num">
          <Num v={data.pct} kind="pct" dir />
        </span>
        <span className="text-ink-3">快照 {fmtTs(data.quoteTs, true)}</span>
        <span className="ml-auto flex items-center gap-2">
          {/* 判定用的是最后一个交易日，不是今天 —— 停牌或数据没采到时必须看得到 */}
          <span className="text-ink-3">读数日期 {t.date}</span>
          {onClose ? (
            <button type="button" className="text-ink-3 hover:text-ink" onClick={onClose}>收起</button>
          ) : null}
        </span>
      </div>

      <div className="flex gap-3">
        <div className="w-[260px] shrink-0">
          <Line
            points={spark}
            marks={[
              { v: lv.resistance, cls: "text-warn", label: "阻力" },
              { v: lv.support, cls: "text-info", label: "支撑" },
              { v: p?.triggerPx ?? data.mine?.triggerPx ?? null, cls: "text-up", label: "触发" },
              { v: p?.stopPx ?? data.mine?.stopPx ?? null, cls: "text-danger", label: "止损" },
            ]}
          />
          <div className="flex flex-wrap gap-x-2 text-[10px] text-ink-3">
            <span className="text-warn">— 阻力 {lv.resistance ?? "—"}</span>
            <span className="text-info">— 支撑 {lv.support ?? "—"}</span>
            <span className="text-up">— 触发 {p?.triggerPx ?? data.mine?.triggerPx ?? "—"}</span>
            <span className="text-danger">— 止损 {p?.stopPx ?? data.mine?.stopPx ?? "—"}</span>
          </div>
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-baseline gap-2">
            <span className="text-ink-3">趋势</span>
            <Tag tone={VERDICT_TONE[t.verdict]}>{t.verdict}</Tag>
            <span className="num text-ink-3">打分 {t.score}</span>
            {t.pattern !== null ? <Tag tone="warn">{t.pattern.kind}·{t.pattern.state}</Tag> : null}
            {lv.atr !== null ? <span className="text-ink-3">ATR <Num v={lv.atr} /></span> : null}
          </div>
          <div className="mt-1 grid grid-cols-2 gap-x-3 gap-y-0.5">
            {t.readouts.map((r) => (
              <div key={r.key} className="flex gap-1.5 min-w-0">
                <span className="text-ink-3 shrink-0">{r.name}</span>
                <span className="text-ink truncate">{r.label ?? "—"}</span>
              </div>
            ))}
          </div>
          {/* 结论怎么来的必须写得出来，否则一个"空头"标签无从复核 */}
          <p className="mt-1 text-ink-3 text-[10px] leading-relaxed">{t.rule}</p>
        </div>
      </div>

      <div className="border-t border-line pt-2">
        {p === null ? (
          <div className="flex gap-2">
            <span className="text-ink-3">买卖点</span>
            <span className="text-ink-2">{data.planReason ?? "引擎今天没有给这只票的判定"}</span>
          </div>
        ) : (
          <div className="flex flex-col gap-1">
            <div className="flex items-baseline gap-2">
              <span className="text-ink-3">买卖点</span>
              <Tag tone={p.action.startsWith("可买") ? "up" : p.action === "不买" ? "down" : "muted"}>{p.action}</Tag>
              {p.gear !== null ? <span className="text-ink-3">今日档位 {p.gear}</span> : null}
              {p.mainline !== null ? <span className="text-ink-3">主线 {p.mainline}</span> : null}
            </div>
            <div className="flex flex-wrap gap-x-4 gap-y-0.5">
              <span className="text-ink-3">触发 <span className="num text-ink"><Num v={p.triggerPx} /></span></span>
              <span className="text-ink-3">止损 <span className="num text-ink"><Num v={p.stopPx} /></span></span>
              <span className="text-ink-3">
                目标 <span className="num text-ink"><Num v={p.targetPx} /></span>
                {/* 补出来的目标价必须标出来：它不是评估器给的，是结构位公式算的参考值 */}
                {p.targetRef ? <span className="ml-1 text-ink-3">（结构位补的参考值）</span> : null}
              </span>
              <span className="text-ink-3">盈亏比 <span className="num text-ink"><Num v={p.rrRatio} /></span></span>
              <span className="text-ink-3">
                距触发 <span className="num"><Num v={p.distanceRatio} kind="ratio" dir /></span>
              </span>
            </div>
            {p.reasons.length > 0 ? (
              <div className="text-ink-2">依据：{p.reasons.join("；")}</div>
            ) : null}
            {p.hints.length > 0 ? (
              <ul className="list-none">
                {p.hints.map((h, i) => (
                  <li key={i} className={HINT_TONE[h.tone] ?? "text-ink-2"}>· {h.text}</li>
                ))}
              </ul>
            ) : null}
          </div>
        )}

        {data.mine !== null ? (
          <div className="mt-1 text-ink-3">
            我填的：触发 <span className="num"><Num v={data.mine.triggerPx} /></span>
            <span className="ml-2">止损 <span className="num"><Num v={data.mine.stopPx} /></span></span>
            {data.mine.thesis ? <span className="ml-2">「{data.mine.thesis}」</span> : null}
            {p !== null && p.triggerPx !== null && data.mine.triggerPx !== null
              && Math.abs(p.triggerPx - data.mine.triggerPx) / data.mine.triggerPx > 0.02 ? (
                <span className="ml-2 text-warn">与引擎给的触发价差 2% 以上，两套数要认一套</span>
              ) : null}
          </div>
        ) : null}
      </div>

      <p className="text-ink-3 text-[10px]">{data.note}</p>
    </div>
  );
}

/**
 * 「分析」按钮 + 展开的面板。
 *
 * 按钮与面板成对出现：面板是按需的，没点开就不发请求、不算引擎。
 * 观察池 20 只票也不该在打开页面时把引擎跑 20 遍。
 */
export function AnalyzeToggle({ code }: { code: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        className="text-info hover:underline"
        title="按需算一次趋势与买卖点（跑一遍引擎，几秒）"
        onClick={() => setOpen(!open)}
      >
        {open ? "收起" : "分析"}
      </button>
      {open ? <AnalyzePanel code={code} onClose={() => setOpen(false)} /> : null}
    </>
  );
}
