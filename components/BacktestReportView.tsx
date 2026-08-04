"use client";

import { useEffect, useRef } from "react";
import { AreaSeries, LineSeries, createChart, type UTCTimestamp } from "lightweight-charts";
import type { BacktestReport } from "@/lib/contracts/backtest";
import { Num } from "@/components/Num";
import { KV, Tag } from "@/components/Panel";

/**
 * 回测报告渲染。
 *
 * spec §10.5：报告首页**必含**覆盖率、缺口天数、低置信因子、有效区间。
 * 所以这四项渲染在最上面、和 metrics 同等份量 —— 只报收益不报这些等于骗自己：
 * 覆盖率 60% 的 Calmar 3.0 和覆盖率 99% 的 Calmar 1.5，后者才是可信的那个。
 *
 * 本组件只在真的拿到 BacktestReport 时才被渲染，不接受任何示例数据。
 */
export function BacktestReportView({ report }: { report: BacktestReport }) {
  const host = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const el = host.current;
    if (!el || report.equity.length === 0) return;

    const chart = createChart(el, {
      layout: {
        background: { color: "#10141b" },
        textColor: "#97a3b6",
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
        fontSize: 11,
      },
      grid: { vertLines: { color: "#1b2230" }, horzLines: { color: "#1b2230" } },
      rightPriceScale: { borderColor: "#232b38" },
      timeScale: { borderColor: "#232b38" },
      height: 300,
      autoSize: true,
    });

    const toTime = (d: string) => (Date.parse(`${d}T00:00:00Z`) / 1000) as UTCTimestamp;

    const eq = chart.addSeries(LineSeries, { color: "#4aa8d8", lineWidth: 2 });
    eq.setData(report.equity.map((p) => ({ time: toTime(p.date), value: p.equity })));

    // 回撤曲线：从净值现算，不额外信任任何字段
    let peak = -Infinity;
    const dd = report.equity.map((p) => {
      peak = Math.max(peak, p.equity);
      return { time: toTime(p.date), value: peak > 0 ? (p.equity - peak) / peak : 0 };
    });
    const ddSeries = chart.addSeries(AreaSeries, {
      lineColor: "#f45b5b",
      topColor: "rgba(244,91,91,0.05)",
      bottomColor: "rgba(244,91,91,0.35)",
      lineWidth: 1,
      priceScaleId: "dd",
    });
    ddSeries.setData(dd);
    chart.priceScale("dd").applyOptions({ scaleMargins: { top: 0.75, bottom: 0 } });
    chart.timeScale().fitContent();

    return () => chart.remove();
  }, [report]);

  const low = report.coverage.lowConfidenceFactors;

  return (
    <div className="flex flex-col gap-3">
      {/* 首页必含四项，位置在 metrics 之前 */}
      <div
        className={`border rounded-sm px-3 py-2 ${
          low.length > 0 || report.coverage.gapDays > 0
            ? "border-warn/60 bg-warn/5"
            : "border-line"
        }`}
      >
        <div className="grid grid-cols-2 md:grid-cols-4 gap-x-6">
          <KV label="数据覆盖率">
            <Num v={report.coverage.coverage} kind="ratio" />
          </KV>
          <KV label="缺口天数">
            <Num v={report.coverage.gapDays} kind="int" />
          </KV>
          <KV label="有效区间">
            {report.coverage.effectiveRange.from} → {report.coverage.effectiveRange.to}
          </KV>
          <KV label="低置信因子">
            <Num v={low.length} kind="int" />
          </KV>
        </div>
        {low.length > 0 ? (
          <p className="mt-2 text-danger text-[12px]">
            ρ&lt;0.8 的代理因子参与了决策：
            {low.map((f) => (
              <span key={f.name} className="ml-2 num">
                {f.name} ρ={f.rho.toFixed(2)}
              </span>
            ))}
            <span className="block text-ink-3 mt-1">
              情绪类因子由日线代理重建，不是真值；结论天然带误差（spec §10.3）。
            </span>
          </p>
        ) : null}
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-x-6">
        <KV label="Calmar" hint="优化目标">
          <Num v={report.metrics.calmar} digits={2} />
        </KV>
        <KV label="年化收益">
          <Num v={report.metrics.annualReturn} kind="ratio" dir />
        </KV>
        <KV label="最大回撤">
          <Num v={report.metrics.maxDrawdown} kind="ratio" />
        </KV>
        <KV label="Sharpe">
          <Num v={report.metrics.sharpe} digits={2} />
        </KV>
        <KV label="胜率">
          <Num v={report.metrics.winRate} kind="ratio" />
        </KV>
        <KV label="盈亏比">
          <Num v={report.metrics.profitFactor} digits={2} />
        </KV>
        <KV label="交易笔数">
          <Num v={report.metrics.trades} kind="int" />
        </KV>
        <KV label="平均持仓天数">
          <Num v={report.metrics.avgHoldDays} digits={1} />
        </KV>
      </div>

      {report.split ? (
        <div className="border border-line rounded-sm px-3 py-2">
          <div className="text-ink-2 mb-1">样本内 / 样本外</div>
          <div className="grid grid-cols-2 gap-x-6">
            <KV label="样本内 Calmar">
              <Num v={report.split.inSample.calmar} digits={2} />
            </KV>
            <KV label="样本外 Calmar">
              <Num v={report.split.outOfSample.calmar} digits={2} />
            </KV>
          </div>
          <p className="mt-1 text-ink-3 text-[11px]">
            样本外不过就是不过，不许回头调样本内（spec §10.4）。
          </p>
        </div>
      ) : null}

      <div>
        <div className="flex items-center gap-2 mb-1 text-[11px] text-ink-3">
          <Tag tone="info">蓝线 净值</Tag>
          <Tag tone="danger">红区 回撤</Tag>
          <span>
            约束：{report.constraints.t1 ? "T+1 " : ""}
            {report.constraints.limitUpUnbuyable ? "涨停买不进 " : ""}
            {report.constraints.limitDownUnsellable ? "跌停卖不出 " : ""}
            滑点 {(report.constraints.slippage * 100).toFixed(2)}% · 费率{" "}
            {(report.constraints.feeRate * 100).toFixed(2)}%
          </span>
        </div>
        <div ref={host} className="w-full" />
      </div>

      <p className="text-ink-3 text-[11px]">
        结果哈希 <span className="num">{report.resultHash}</span> ·
        同份输入两次运行必须一致（spec §17 断言 4）。
        回测 ≠ 实盘：封板买不进、滑点、情绪不可完全量化。
      </p>
    </div>
  );
}
