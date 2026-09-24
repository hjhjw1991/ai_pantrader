"use client";

import { useEffect, useRef, useState } from "react";
import {
  CandlestickSeries, HistogramSeries, LineSeries, LineStyle, createChart, createSeriesMarkers,
  type IChartApi, type ISeriesApi, type SeriesMarker, type Time, type UTCTimestamp,
} from "lightweight-charts";
import type { ChartData } from "@/lib/ui/adapters/chart";
import { CHART_EVENT, type ChartRequest } from "@/components/ChartLink";

/**
 * 个股 K 线：前复权日线 + MA20 + 成交量，下方日线 MACD。
 *
 * 图上的标注全部来自因子层（结构位、M 顶 W 底、MACD 交叉），不在前端另算信号 ——
 * 图上随手画的箭头会被当成系统给的信号，所以只画引擎也看得到的东西。
 * 计划价位（触发 / 止损 / 目标 / 成本）由调用方传进来：从候选或持仓点过来时才有。
 *
 * 红涨绿跌（中国惯例）。
 */

export interface PlanLevels { trigger?: number | null; stop?: number | null; target?: number | null; cost?: number | null }

const C = {
  up: "#f45b5b", down: "#3fb27f", warn: "#e0b341", info: "#4aa8d8", ink2: "#97a3b6", ink3: "#5d6778",
  bg: "#10141b", grid: "#1b2230", border: "#232b38", violet: "#b18cf0",
};
const toTime = (d: string) => (Date.parse(`${d}T00:00:00Z`) / 1000) as UTCTimestamp;

type Layer = "交叉" | "周线" | "结构位" | "形态" | "计划";
const LAYERS: Layer[] = ["交叉", "周线", "结构位", "形态", "计划"];

export function StockChart({ initialCode, initialLevels }: { initialCode?: string; initialLevels?: PlanLevels }) {
  const [input, setInput] = useState(initialCode ?? "");
  const [code, setCode] = useState(initialCode ?? "");
  const [levels, setLevels] = useState<PlanLevels | undefined>(initialLevels);

  // 页面里任意"看图"按钮都通过这个事件换票，不跳页、不重算整页
  useEffect(() => {
    const on = (e: Event) => {
      const r = (e as CustomEvent<ChartRequest>).detail;
      if (!r || !/^\d{6}$/.test(r.code)) return;
      setInput(r.code); setCode(r.code); setLevels(r.levels);
    };
    window.addEventListener(CHART_EVENT, on);
    return () => window.removeEventListener(CHART_EVENT, on);
  }, []);
  const [data, setData] = useState<ChartData | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [on, setOn] = useState<Record<Layer, boolean>>({ 交叉: true, 周线: true, 结构位: true, 形态: true, 计划: true });
  const [hover, setHover] = useState<ChartData["bars"][number] | null>(null);
  const host = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!code) return;
    let alive = true;
    setLoading(true); setErr(null);
    fetch(`/api/data/chart?code=${encodeURIComponent(code)}&n=250`)
      .then(async r => { const j = await r.json(); if (!r.ok) throw new Error(j?.error ?? `HTTP ${r.status}`); return j as ChartData; })
      .then(j => { if (alive) setData(j); })
      .catch((e: Error) => { if (alive) { setErr(e.message); setData(null); } })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [code]);

  useEffect(() => {
    const el = host.current;
    if (!el || !data || data.bars.length === 0) return;
    const chart: IChartApi = createChart(el, {
      layout: { background: { color: C.bg }, textColor: C.ink2, fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: 11 },
      grid: { vertLines: { color: C.grid }, horzLines: { color: C.grid } },
      rightPriceScale: { borderColor: C.border },
      timeScale: { borderColor: C.border, rightOffset: 6 },
      crosshair: { mode: 0 },
      height: 520, autoSize: true,
      // 滚轮交给下面自己接管：库默认"上下滚 = 缩放"，触控板双指上下滑本想滚页面，结果把 K 线缩没了
      handleScale: { mouseWheel: false },
      handleScroll: { mouseWheel: false },
    });

    /**
     * 滚轮 / 触控板手势：
     *   双指上下滑（deltaY 为主） → 不拦，页面照常滚动
     *   双指左右滑（deltaX 为主） → 平移 K 线
     *   双指捏合（浏览器报成 ctrlKey + wheel） → 以指针所在处为中心缩放
     */
    const onWheel = (e: WheelEvent) => {
      const ts = chart.timeScale();
      const r = ts.getVisibleLogicalRange();
      if (r === null) return;
      if (e.ctrlKey) {
        e.preventDefault();
        const span = r.to - r.from;
        const next = Math.min(Math.max(span * Math.exp(e.deltaY * 0.005), 30), data.bars.length + 20);
        const rect = el.getBoundingClientRect();
        const anchor = r.from + span * Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
        const k = (anchor - r.from) / span;
        ts.setVisibleLogicalRange({ from: anchor - next * k, to: anchor + next * (1 - k) });
        return;
      }
      if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
        e.preventDefault();
        const perPx = (r.to - r.from) / Math.max(1, el.clientWidth);
        const d = e.deltaX * perPx;
        ts.setVisibleLogicalRange({ from: r.from + d, to: r.to + d });
      }
    };
    el.addEventListener("wheel", onWheel, { passive: false });

    /* ── 价格窗 ── */
    const candles = chart.addSeries(CandlestickSeries, {
      upColor: C.up, downColor: C.down, borderUpColor: C.up, borderDownColor: C.down, wickUpColor: C.up, wickDownColor: C.down,
    });
    candles.setData(data.bars.map(b => ({ time: toTime(b.date), open: b.o, high: b.h, low: b.l, close: b.c })));

    const ma = chart.addSeries(LineSeries, { color: C.warn, lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
    const N = 20, maData: Array<{ time: UTCTimestamp; value: number }> = [];
    for (let i = N - 1; i < data.bars.length; i++) {
      let s = 0; for (let j = i - N + 1; j <= i; j++) s += data.bars[j].c;
      maData.push({ time: toTime(data.bars[i].date), value: s / N });
    }
    ma.setData(maData);

    const vol = chart.addSeries(HistogramSeries, { priceScaleId: "vol", priceFormat: { type: "volume" }, lastValueVisible: false, priceLineVisible: false });
    chart.priceScale("vol").applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
    vol.setData(data.bars.map(b => ({ time: toTime(b.date), value: b.vol, color: b.c >= b.o ? "rgba(244,91,91,0.35)" : "rgba(63,178,127,0.35)" })));

    const line = (s: ISeriesApi<any>, price: number | null | undefined, color: string, title: string, style = LineStyle.Dashed) => {
      if (typeof price === "number" && Number.isFinite(price)) {
        s.createPriceLine({ price, color, lineWidth: 1, lineStyle: style, axisLabelVisible: true, title });
      }
    };
    if (on.结构位 && data.structure) {
      line(candles, data.structure.resistance, C.warn, "阻力", LineStyle.Dotted);
      line(candles, data.structure.support, C.info, "支撑", LineStyle.Dotted);
    }
    if (on.计划 && levels) {
      line(candles, levels.trigger, C.ink2, "触发", LineStyle.Solid);
      line(candles, levels.stop, C.down, "止损", LineStyle.Solid);
      line(candles, levels.target, C.up, "目标", LineStyle.Solid);
      line(candles, levels.cost, C.violet, "成本", LineStyle.Dashed);
    }

    const priceMarkers: SeriesMarker<Time>[] = [];
    if (on.周线) {
      for (const x of data.weeklyCrosses) {
        priceMarkers.push({
          time: toTime(x.date), position: x.kind === "金叉" ? "belowBar" : "aboveBar",
          color: x.kind === "金叉" ? C.up : C.down, shape: x.kind === "金叉" ? "arrowUp" : "arrowDown", text: `周${x.kind}`,
        });
      }
    }
    if (on.形态 && data.pattern) {
      const p = data.pattern;
      const poly = chart.addSeries(LineSeries, { color: C.violet, lineWidth: 2, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
      const pts = [...p.points].sort((a, b) => (a.date < b.date ? -1 : 1));
      poly.setData(pts.map(x => ({ time: toTime(x.date), value: x.price })));
      const last = data.bars[data.bars.length - 1].date;
      const neck = chart.addSeries(LineSeries, { color: C.violet, lineWidth: 1, lineStyle: LineStyle.Dashed, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
      neck.setData([{ time: toTime(pts[0].date), value: p.neckline }, { time: toTime(last), value: p.neckline }]);
      for (const x of pts) {
        priceMarkers.push({ time: toTime(x.date), position: p.kind === "M顶" ? "aboveBar" : "belowBar", color: C.violet, shape: "circle", text: x.role });
      }
      if (p.breakDate) priceMarkers.push({ time: toTime(p.breakDate), position: p.kind === "M顶" ? "aboveBar" : "belowBar", color: C.violet, shape: "square", text: "破颈" });
    }
    priceMarkers.sort((a, b) => (a.time as number) - (b.time as number));
    createSeriesMarkers(candles, priceMarkers);

    /* ── MACD 窗 ── */
    const hist = chart.addSeries(HistogramSeries, { priceLineVisible: false, lastValueVisible: false }, 1);
    hist.setData(data.macd.map(m => ({ time: toTime(m.date), value: m.hist, color: m.hist >= 0 ? "rgba(244,91,91,0.6)" : "rgba(63,178,127,0.6)" })));
    const dif = chart.addSeries(LineSeries, { color: "#e6e9ef", lineWidth: 1, priceLineVisible: false, lastValueVisible: false }, 1);
    dif.setData(data.macd.map(m => ({ time: toTime(m.date), value: m.dif })));
    const dea = chart.addSeries(LineSeries, { color: C.warn, lineWidth: 1, priceLineVisible: false, lastValueVisible: false }, 1);
    dea.setData(data.macd.map(m => ({ time: toTime(m.date), value: m.dea })));
    if (on.交叉) {
      createSeriesMarkers(dif, data.dailyCrosses.map(x => ({
        time: toTime(x.date), position: x.kind === "金叉" ? "belowBar" : "aboveBar",
        color: x.kind === "金叉" ? C.up : C.down, shape: x.kind === "金叉" ? "arrowUp" : "arrowDown",
        text: x.aboveZero ? x.kind : "",
      })), { autoScale: false });   // MACD 窗只有 140px：放大后标记跟着变大，会把刻度撑到几百
    }
    const panes = chart.panes();
    if (panes.length > 1) panes[1].setHeight(140);

    const byTime = new Map(data.bars.map(b => [toTime(b.date) as number, b]));
    chart.subscribeCrosshairMove(p => setHover(p.time === undefined ? null : byTime.get(p.time as number) ?? null));
    chart.timeScale().setVisibleLogicalRange({ from: Math.max(0, data.bars.length - 160), to: data.bars.length + 4 });
    return () => { el.removeEventListener("wheel", onWheel); chart.remove(); };
  }, [data, on, levels]);

  const last = data && data.bars.length > 0 ? data.bars[data.bars.length - 1] : null;
  const b = hover ?? last;
  const prev = b && data ? data.bars[data.bars.findIndex(x => x.date === b.date) - 1] : undefined;
  const chg = b && prev ? b.c / prev.c - 1 : null;

  return (
    <div>
      <form className="flex flex-wrap items-center gap-2 mb-2" onSubmit={e => {
        e.preventDefault();
        const v = input.trim();
        if (/^\d{6}$/.test(v)) { if (v !== code) setLevels(undefined); setCode(v); setErr(null); } else setErr("代码必须是 6 位数字");
      }}>
        <input value={input} onChange={e => setInput(e.target.value)} placeholder="600519" inputMode="numeric"
          className="num w-28 bg-panel-2 border border-line-2 rounded-sm px-2 py-1 text-ink" />
        <button type="submit" className="border border-line-2 rounded-sm px-2 py-1 text-ink-2 hover:text-ink">载入</button>
        {data ? <span className="text-ink">{data.code} {data.name ?? ""}</span> : null}
        {loading ? <span className="text-ink-3">读取中…</span> : null}
        {err ? <span className="text-danger">{err}</span> : null}
        <span className="ml-auto flex gap-2 text-[11px]">
          {LAYERS.map(k => (
            <label key={k} className="flex items-center gap-1 text-ink-2 cursor-pointer">
              <input type="checkbox" checked={on[k]} onChange={e => setOn({ ...on, [k]: e.target.checked })} />{k}
            </label>
          ))}
        </span>
      </form>

      {!code ? <p className="text-ink-3">输入代码，或在候选池 / 持仓里点"看图"。</p>
        : data && data.bars.length === 0 ? <p className="text-warn">{data.note}</p> : null}

      {b ? (
        <div className="num text-[11px] text-ink-2 mb-1 flex flex-wrap gap-x-3">
          <span className="text-ink">{b.date}</span>
          <span>开 {b.o.toFixed(2)}</span><span>高 {b.h.toFixed(2)}</span><span>低 {b.l.toFixed(2)}</span>
          <span>收 <span className={chg === null ? "" : chg >= 0 ? "text-up" : "text-down"}>{b.c.toFixed(2)}</span></span>
          {chg !== null ? <span className={chg >= 0 ? "text-up" : "text-down"}>{(chg * 100).toFixed(2)}%</span> : null}
          {data?.structure ? <span>结构位：阻力 {data.structure.resistance ?? "—"} / 支撑 {data.structure.support ?? "—"}（{data.structure.label}）</span> : null}
          {data?.pattern ? <span className="text-[#b18cf0]">{data.pattern.kind}{data.pattern.state} · 颈线 {data.pattern.neckline.toFixed(2)}</span> : null}
          {data?.atr ? <span>ATR {data.atr.toFixed(2)}</span> : null}
        </div>
      ) : null}

      <div ref={host} className="w-full" />
      {data && data.bars.length > 0 ? (
        <p className="mt-1 text-[11px] text-ink-3">
          {data.bars.length} 根日线 · {data.bars[0].date} → {data.bars[data.bars.length - 1].date} · 黄线 MA20 ·
          下窗 MACD(12,26,9)，箭头 = 日线金叉/死叉（零轴上方的标字）· 价格窗箭头 = 周线交叉 · 紫色 = M 顶 / W 底与颈线 ·
          点线 = 结构位 · 实线 = 计划价位。{data.note}
        </p>
      ) : null}
    </div>
  );
}
