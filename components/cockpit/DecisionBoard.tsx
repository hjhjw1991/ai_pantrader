"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import type { CockpitItem, ItemGroup } from "@/lib/ui/adapters/cockpit";
import { StockChart } from "@/components/StockChart";
import { openChart } from "@/components/ChartLink";

/**
 * 作战台的中栏 + 右栏：右边是自选列表（候选 / 持仓 / 观察），点哪只，中间就换成那只的决策卡与 K 线。
 *
 * 决策卡只摆引擎已经给出的结论：动作、价位、理由、技术面提示。
 * 大字是结论，价位卡是执行要用的数，技术面提示单独一块、标明参考 —— 一眼分得清哪个必须照做。
 * ↑ / ↓ 在列表里换票（焦点在输入框里时不拦）。
 */

const TONE_TEXT: Record<CockpitItem["tone"], string> = {
  buy: "text-up", sell: "text-down", hold: "text-info", wait: "text-warn", no: "text-ink-3",
};
const TONE_BG: Record<CockpitItem["tone"], string> = {
  buy: "bg-up", sell: "bg-down", hold: "bg-info", wait: "bg-warn", no: "bg-line-2",
};
const HINT_TONE: Record<string, string> = { 正面: "text-up border-up/40", 负面: "text-down border-down/40", 中性: "text-ink-2 border-line-2" };
const GROUPS: ItemGroup[] = ["候选", "持仓", "观察"];

const px = (x: number | null | undefined) => (typeof x === "number" && Number.isFinite(x) ? x.toFixed(2) : "—");
const pctTxt = (x: number | null) => (x === null ? "" : `${x >= 0 ? "+" : ""}${(x * 100).toFixed(1)}%`);
const rel = (a: number | null, b: number | null) => (a !== null && b !== null && b > 0 ? a / b - 1 : null);

function Spark({ xs, up }: { xs: number[]; up: boolean | null }) {
  if (xs.length < 2) return <span className="w-20 h-6 inline-block" />;
  const lo = Math.min(...xs), hi = Math.max(...xs), w = 80, h = 24;
  const pts = xs.map((v, i) => `${(i / (xs.length - 1)) * w},${hi === lo ? h / 2 : h - ((v - lo) / (hi - lo)) * h}`).join(" ");
  return (
    <svg width={w} height={h} className="shrink-0" aria-hidden>
      <polyline points={pts} fill="none" strokeWidth="1.2" className={up === null ? "stroke-ink-3" : up ? "stroke-up" : "stroke-down"} />
    </svg>
  );
}

/** 盈亏比环：满格 = 3 倍。低于 1.5 标黄 —— 结构位定价槽的门槛就是 1.5 */
function RrRing({ rr }: { rr: number | null }) {
  const r = 30, c = 2 * Math.PI * r, frac = rr === null ? 0 : Math.max(0, Math.min(1, rr / 3));
  const tone = rr === null ? "stroke-line-2" : rr >= 2 ? "stroke-up" : rr >= 1.5 ? "stroke-info" : "stroke-warn";
  return (
    <div className="flex flex-col items-center shrink-0">
      <svg width="76" height="76" viewBox="0 0 76 76">
        <circle cx="38" cy="38" r={r} fill="none" strokeWidth="6" className="stroke-panel-2" />
        <circle cx="38" cy="38" r={r} fill="none" strokeWidth="6" strokeLinecap="round" className={tone}
          strokeDasharray={`${c * frac} ${c}`} transform="rotate(-90 38 38)" />
        <text x="38" y="43" textAnchor="middle" className="fill-ink text-[15px] font-medium num">{rr === null ? "—" : rr.toFixed(2)}</text>
      </svg>
      <span className="text-[11px] text-ink-3">盈亏比</span>
    </div>
  );
}

function PriceCard({ label, value, sub, tone, note }: { label: string; value: string; sub?: string; tone?: string; note?: string }) {
  return (
    <div className="flex-1 min-w-[7rem] px-3 py-2 border-r border-line last:border-0">
      <div className="text-[11px] text-ink-3 tracking-wide">{label}</div>
      <div className={`num text-xl font-medium ${tone ?? "text-ink"}`}>{value}</div>
      <div className="text-[11px] text-ink-3 num">{sub ?? " "}{note ? <span className="ml-1">{note}</span> : null}</div>
    </div>
  );
}

function nextStep(it: CockpitItem): string {
  if (it.group === "候选") {
    return it.triggerPx === null ? "引擎没给触发价，先别动。"
      : `价格回落到 ${px(it.triggerPx)} 及以下再挂限价买入${it.stopPx !== null ? `，止损 ${px(it.stopPx)}` : "（该账户没配止损，自己定好再买）"}；成交后回来在「我的股票」里回填。`;
  }
  if (it.group === "持仓") {
    if (it.tone === "sell") return `纪律要求${it.action}：按纪律执行，执行后回填成交。`;
    return `纪律：${it.action}${it.stopPx !== null ? `，收盘跌破 ${px(it.stopPx)} 离场` : ""}。技术面倾向「${it.lean ?? "—"}」只作参考。`;
  }
  if (it.tone === "buy") return `到价 ${px(it.triggerPx)} 可买${it.stopPx !== null ? `，止损 ${px(it.stopPx)}` : ""}。`;
  return "今天不买，理由见上。";
}

function Hero({ it }: { it: CockpitItem }) {
  const up = it.pct === null ? null : it.pct >= 0;
  const toTrig = rel(it.triggerPx, it.price);
  const loss = rel(it.stopPx, it.triggerPx ?? it.price);
  const gain = rel(it.targetPx, it.triggerPx ?? it.price);
  const why = it.group === "观察" ? it.reasons.join("；") : it.thesis;
  return (
    <section className="bg-panel border border-line rounded-sm overflow-hidden">
      <div className={`h-1 ${TONE_BG[it.tone]}`} />
      <div className="p-4 flex gap-4 items-start">
        <div className="flex-1 min-w-0">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <span className={`text-3xl font-semibold tracking-wide ${TONE_TEXT[it.tone]}`}>{it.action}</span>
            <span className="text-lg text-ink">{it.name ?? "—"}</span>
            <span className="num text-ink-2">{it.code}</span>
            <span className="text-[11px] border border-line-2 rounded-sm px-1 text-ink-2">{it.group}</span>
            {it.account ? <span className="text-[11px] text-ink-3">账户 {it.account}</span> : null}
            {it.lean ? <span className="text-[11px] text-ink-3">技术面倾向 <span className="text-ink-2">{it.lean}</span></span> : null}
          </div>
          <p className="mt-2 text-[13px] leading-6 text-ink-2">{why || "—"}</p>
        </div>
        <RrRing rr={it.rrRatio} />
      </div>

      <div className="flex flex-wrap border-t border-line bg-panel-2/60">
        <PriceCard label="现价" value={px(it.price)} tone={up === null ? undefined : up ? "text-up" : "text-down"}
          sub={it.pct === null ? undefined : `${it.pct >= 0 ? "+" : ""}${it.pct.toFixed(2)}%`} />
        <PriceCard label={it.group === "持仓" ? "参考价" : "触发价"} value={px(it.triggerPx)} sub={toTrig === null ? undefined : `距现价 ${pctTxt(toTrig)}`} />
        <PriceCard label="止损" value={px(it.stopPx)} tone="text-down" sub={loss === null ? undefined : `计划亏损 ${pctTxt(loss)}`} />
        <PriceCard label="目标" value={px(it.targetPx)} tone="text-up" sub={gain === null ? undefined : `空间 ${pctTxt(gain)}`}
          note={it.targetRef && it.targetPx !== null ? "参考" : undefined} />
      </div>

      <div className="px-4 py-3 border-t border-line flex flex-col gap-2">
        {it.hints.length > 0 ? (
          <div className="flex flex-wrap gap-1.5">
            <span className="text-[11px] text-ink-3 mr-1 self-center">技术面（参考）</span>
            {it.hints.map((h, i) => <span key={i} className={`text-[12px] border rounded-sm px-1.5 py-0.5 ${HINT_TONE[h.tone]}`}>{h.text}</span>)}
          </div>
        ) : null}
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-ink-3">
          <span>日 / 周 MACD <span className="text-ink-2">{it.daily ?? "—"} / {it.weekly ?? "—"}</span></span>
          <span>阻力 / 支撑 <span className="num text-ink-2">{px(it.resistance)} / {px(it.support)}</span></span>
          {it.size !== null ? <span>建议仓位 <span className="num text-ink-2">{(it.size * 100).toFixed(1)}%</span></span> : null}
          {it.score !== null ? <span>评分 <span className="num text-ink-2">{it.score.toFixed(2)}</span></span> : null}
          {it.mainline ? <span>主线 <span className="text-ink-2">{it.mainline}</span></span> : null}
          {it.filters.length > 0 ? <span title={it.filters.join(" / ")}>过筛 <span className="text-ink-2">{it.filters.length} 道</span></span> : null}
          {it.lowConf.length > 0 ? <span title={it.lowConf.join(" ")}>低置信 <span className="text-warn">{it.lowConf.join(" ")}</span></span> : null}
        </div>
      </div>

      <div className="px-4 py-2.5 border-t border-line border-l-2 border-l-info bg-info/5 flex items-center gap-3">
        <span className="text-info text-[11px] font-medium tracking-widest shrink-0">下一步</span>
        <span className="text-[13px] text-ink">{nextStep(it)}</span>
        <Link href="/positions" scroll={false} className="ml-auto shrink-0 text-[12px] border border-line-2 rounded-sm px-2 py-0.5 text-ink-2 hover:text-ink">回填成交</Link>
      </div>
    </section>
  );
}

function WatchRow({ it, active, onPick }: { it: CockpitItem; active: boolean; onPick: () => void }) {
  const up = it.pct === null ? null : it.pct >= 0;
  return (
    <button type="button" onClick={onPick}
      className={`w-full text-left flex items-center gap-2 px-3 py-2 border-b border-line/60 ${active ? "bg-panel-2 border-l-2 border-l-info" : "hover:bg-panel-2/60 border-l-2 border-l-transparent"}`}>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5">
          <span className="text-ink truncate">{it.name ?? it.code}</span>
          <span className={`text-[10px] ${TONE_TEXT[it.tone]}`}>{it.action}</span>
        </span>
        <span className="num text-[11px] text-ink-3">{it.code}</span>
      </span>
      <Spark xs={it.spark} up={up} />
      <span className="w-16 text-right shrink-0">
        <span className="num block text-ink">{px(it.price)}</span>
        <span className={`num block text-[11px] ${up === null ? "text-ink-3" : up ? "text-up" : "text-down"}`}>
          {it.pct === null ? "—" : `${it.pct >= 0 ? "+" : ""}${it.pct.toFixed(2)}%`}
        </span>
      </span>
    </button>
  );
}

export function DecisionBoard({ items, emptyNote }: { items: CockpitItem[]; emptyNote: string }) {
  const [sel, setSel] = useState<string | null>(items[0]?.key ?? null);
  const cur = useMemo(() => items.find(i => i.key === sel) ?? items[0] ?? null, [items, sel]);

  // 选中哪只，K 线就换成哪只并带上计划价位
  useEffect(() => {
    if (cur) openChart({ code: cur.code, levels: { trigger: cur.triggerPx, stop: cur.stopPx, target: cur.targetPx } });
  }, [cur?.key]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if (document.querySelector("[role=dialog]")) return;   // 抽屉开着时不抢它的方向键
      const i = items.findIndex(x => x.key === cur?.key);
      const j = e.key === "ArrowDown" ? Math.min(items.length - 1, i + 1) : Math.max(0, i - 1);
      if (items[j]) { e.preventDefault(); setSel(items[j].key); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [items, cur?.key]);

  return (
    <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_320px] gap-3 items-start">
      <div className="flex flex-col gap-3 min-w-0">
        {cur ? <Hero it={cur} /> : (
          <section className="bg-panel border border-line rounded-sm p-6 text-ink-3">{emptyNote}</section>
        )}
        <section id="chart" className="bg-panel border border-line rounded-sm p-3 min-w-0">
          <StockChart initialCode={cur?.code} initialLevels={cur ? { trigger: cur.triggerPx, stop: cur.stopPx, target: cur.targetPx } : undefined} />
        </section>
      </div>

      <aside className="bg-panel border border-line rounded-sm xl:sticky xl:top-2 overflow-hidden">
        <header className="flex items-baseline gap-2 px-3 py-2 border-b border-line bg-panel-2">
          <span className="text-warn">★</span>
          <span className="text-ink font-medium">自选</span>
          <span className="text-[11px] text-ink-3">{items.length} 只 · ↑↓ 切换</span>
          <Link href="/positions" scroll={false} className="ml-auto text-[11px] text-info">管理 →</Link>
        </header>
        {GROUPS.map(g => {
          const list = items.filter(i => i.group === g);
          return (
            <div key={g}>
              <div className="px-3 pt-2 pb-1 text-[11px] text-ink-3 flex justify-between">
                <span>{g === "候选" ? "今日候选" : g === "持仓" ? "持仓" : "观察池"}</span><span className="num">{list.length}</span>
              </div>
              {list.length === 0 ? <div className="px-3 pb-2 text-[11px] text-ink-3">{g === "候选" ? "今日无买入候选" : g === "持仓" ? "没有持仓" : "观察池是空的"}</div>
                : list.map(it => <WatchRow key={it.key} it={it} active={cur?.key === it.key} onPick={() => setSel(it.key)} />)}
            </div>
          );
        })}
      </aside>
    </div>
  );
}
