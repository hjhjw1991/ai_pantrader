"use client";

import { useEffect, useRef, useState } from "react";
import {
  CandlestickSeries,
  LineSeries,
  createChart,
  type IChartApi,
  type UTCTimestamp,
} from "lightweight-charts";

interface Bar {
  date: string;
  o: number;
  h: number;
  l: number;
  c: number;
  vol: number;
}

/**
 * 个股日线。数据来自 kline_daily（真实历史），只画 K 线与 MA20。
 *
 * 不在这里画任何"信号标记"——买卖点属于策略引擎的输出，
 * 图上随手标一个箭头会被当成系统给的信号。
 *
 * 红涨绿跌（中国惯例）。
 */
export function DailyChart() {
  const [code, setCode] = useState("");
  const [input, setInput] = useState("");
  const [bars, setBars] = useState<Bar[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const host = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);

  useEffect(() => {
    if (!code) return;
    let alive = true;
    setLoading(true);
    setErr(null);
    fetch(`/api/data/kline?code=${encodeURIComponent(code)}&n=250`)
      .then(async (r) => {
        const j = await r.json();
        if (!r.ok) throw new Error(j?.error ?? `HTTP ${r.status}`);
        return j as { bars: Bar[] };
      })
      .then((j) => {
        if (!alive) return;
        setBars(j.bars);
      })
      .catch((e: Error) => {
        if (!alive) return;
        setErr(e.message);
        setBars(null);
      })
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [code]);

  useEffect(() => {
    const el = host.current;
    if (!el || !bars || bars.length === 0) return;

    const chart = createChart(el, {
      layout: {
        background: { color: "#10141b" },
        textColor: "#97a3b6",
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
        fontSize: 11,
      },
      grid: {
        vertLines: { color: "#1b2230" },
        horzLines: { color: "#1b2230" },
      },
      rightPriceScale: { borderColor: "#232b38" },
      timeScale: { borderColor: "#232b38", rightOffset: 4 },
      crosshair: { mode: 0 },
      height: 320,
      autoSize: true,
    });
    chartRef.current = chart;

    const candles = chart.addSeries(CandlestickSeries, {
      // 红涨绿跌
      upColor: "#f45b5b",
      downColor: "#3fb27f",
      borderUpColor: "#f45b5b",
      borderDownColor: "#3fb27f",
      wickUpColor: "#f45b5b",
      wickDownColor: "#3fb27f",
    });
    const toTime = (d: string) => (Date.parse(`${d}T00:00:00Z`) / 1000) as UTCTimestamp;
    candles.setData(
      bars.map((b) => ({ time: toTime(b.date), open: b.o, high: b.h, low: b.l, close: b.c }))
    );

    // MA20：均线是纯几何计算，不是因子，标注清楚即可
    const ma = chart.addSeries(LineSeries, { color: "#e0b341", lineWidth: 1 });
    const N = 20;
    const maData: Array<{ time: UTCTimestamp; value: number }> = [];
    for (let i = N - 1; i < bars.length; i++) {
      let s = 0;
      for (let j = i - N + 1; j <= i; j++) s += bars[j].c;
      maData.push({ time: toTime(bars[i].date), value: s / N });
    }
    ma.setData(maData);
    chart.timeScale().fitContent();

    return () => {
      chart.remove();
      chartRef.current = null;
    };
  }, [bars]);

  return (
    <div>
      <form
        className="flex items-center gap-2 mb-2"
        onSubmit={(e) => {
          e.preventDefault();
          const v = input.trim();
          if (/^\d{6}$/.test(v)) {
            setCode(v);
            setErr(null);
          } else {
            setErr("代码必须是 6 位数字");
          }
        }}
      >
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="600519"
          inputMode="numeric"
          className="num w-28 bg-panel-2 border border-line-2 rounded-sm px-2 py-1 text-ink"
        />
        <button
          type="submit"
          className="border border-line-2 rounded-sm px-2 py-1 text-ink-2 hover:text-ink"
        >
          载入
        </button>
        {code ? <span className="num text-ink-2">{code}</span> : null}
        {loading ? <span className="text-ink-3">读取中…</span> : null}
        {err ? <span className="text-danger">{err}</span> : null}
      </form>

      {!code ? (
        <p className="text-ink-3">输入代码后从 kline_daily 读取，不预载任何示例数据。</p>
      ) : bars && bars.length === 0 ? (
        <p className="text-warn">kline_daily 里没有 {code} 的日线 —— 检查代码或采集覆盖。</p>
      ) : null}

      <div ref={host} className="w-full" />
      {bars && bars.length > 0 ? (
        <p className="mt-1 text-[11px] text-ink-3">
          {bars.length} 根日线 · {bars[0].date} → {bars[bars.length - 1].date} · 黄线 MA20
          （几何均线，不是因子）· 未做复权处理，2022-05~2023-12 区间无复权参照（spec R1）
        </p>
      ) : null}
    </div>
  );
}
