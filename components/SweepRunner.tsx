"use client";

import { useMemo, useState } from "react";
import type { SweepReport } from "@/lib/contracts/backtest";
import { DateInput } from "@/components/DateInput";

/**
 * 参数扫描 + 热力图（spec §10.4）。
 *
 * 三条显示纪律，来自"这张图会被拿来决定投多少钱"：
 *   1. **格子只有真评估过才上色**，null 一律画成空白并在图例里说明 ——
 *      给没跑过的格子插值/补零，等于把没做过的实验画成结论；
 *   2. **overfitRisk 必须比最优点更显眼**：一个只在某点好、隔壁全烂的参数不是发现，
 *      是巧合。界面把峰陡度放在最优 Calmar 旁边，不折叠、不缩小；
 *   3. **覆盖率与最优点同屏**：覆盖率 60% 的 Calmar 3.0 不如覆盖率 99% 的 1.5。
 */

const btnCls =
  "border border-line rounded-sm px-2 py-0.5 text-[12px] text-ink-2 hover:text-ink hover:border-line-2 disabled:opacity-40";
const inputCls = "num bg-panel-2 border border-line-2 rounded-sm px-1 text-ink";

type Msg = { kind: "ok" | "err" | "warn"; text: string } | null;

/** 一条轴：参数路径 + 逗号分隔的取值 */
interface AxisDraft {
  path: string;
  values: string;
}

/** "0.6, 0.7,0.8" → [0.6,0.7,0.8]；"true,false" → [true,false]。解析不了的原样留着好报错 */
function parseValues(s: string): { ok: true; values: Array<number | boolean> } | { ok: false; bad: string } {
  const parts = s.split(",").map((x) => x.trim()).filter((x) => x !== "");
  const out: Array<number | boolean> = [];
  for (const p of parts) {
    if (p === "true" || p === "false") { out.push(p === "true"); continue; }
    const n = Number(p);
    if (!Number.isFinite(n)) return { ok: false, bad: p };
    out.push(n);
  }
  return { ok: true, values: out };
}

const fmtAxisValue = (v: unknown) =>
  typeof v === "number" ? String(Number(v.toFixed(6))) : String(v);

const fmtDur = (ms: number) =>
  ms < 60_000 ? `${Math.round(ms / 1000)} 秒` : `${Math.round(ms / 60_000)} 分钟`;

export function SweepRunner({
  paramPaths,
  defaultRange,
  maxPoints,
}: {
  /** 可选轴 = 当前配置里的纯量路径。不让用户手打，打错了要跑完才知道 */
  paramPaths: string[];
  defaultRange: { from: string; to: string };
  maxPoints: number;
}) {
  const [from, setFrom] = useState(defaultRange.from);
  const [to, setTo] = useState(defaultRange.to);
  const [cash, setCash] = useState("100000");
  const [axes, setAxes] = useState<AxisDraft[]>([
    { path: paramPaths[0] ?? "", values: "" },
    { path: paramPaths[1] ?? "", values: "" },
  ]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<Msg>(null);
  const [report, setReport] = useState<SweepReport | null>(null);
  /** 实测单点耗时（毫秒）。null = 还没测 */
  const [perPointMs, setPerPointMs] = useState<number | null>(null);

  const parsed = useMemo(
    () => axes.map((a) => ({ path: a.path, r: parseValues(a.values) })),
    [axes]
  );
  const badAxis = parsed.find((p) => !p.r.ok);
  const counts = parsed.map((p) => (p.r.ok ? p.r.values.length : 0));
  const points = counts.every((c) => c >= 2) ? counts.reduce((a, b) => a * b, 1) : 0;
  const overCap = points > maxPoints;
  const dupPath = new Set(axes.map((a) => a.path)).size !== axes.length;
  const canRun =
    !busy && points >= 4 && !overCap && !dupPath && badAxis === undefined && from !== "" && to !== "";
  const estMs = perPointMs === null || points === 0 ? null : perPointMs * points;

  /**
   * 测速：拿当前区间跑**一次**普通回测并计时。
   *
   * 为什么必须实测而不是给个经验值：单点耗时几乎全由区间长度决定 ——
   * 实测过 2026-06-01~06-30 是约 34 秒/点，36 点就是 20 分钟同步阻塞；
   * 换成 5 天区间可能 3 秒/点，同样 36 点两分钟就完。
   * 点数上限拦不住这件事，只有"先量一次再乘"能。
   */
  async function measure() {
    setBusy(true);
    setMsg(null);
    const t0 = performance.now();
    try {
      const r = await fetch("/api/backtest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ from, to, initialCash: Number(cash) }),
      });
      const ms = performance.now() - t0;
      const j = (await r.json()) as Record<string, unknown>;
      if (!r.ok) {
        setMsg({ kind: "err", text: `测速失败：${String(j.error ?? r.status)}` });
        return;
      }
      setPerPointMs(ms);
      setMsg({ kind: "ok", text: `单点实测 ${(ms / 1000).toFixed(1)} 秒（这一次也是一次真回测）` });
    } catch (e) {
      setMsg({ kind: "err", text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  async function run() {
    setBusy(true);
    setMsg(null);
    setReport(null);
    const grid: Record<string, Array<number | boolean>> = {};
    for (const p of parsed) if (p.r.ok) grid[p.path] = p.r.values;
    try {
      const r = await fetch("/api/backtest/sweep", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          from, to,
          initialCash: Number(cash),
          grid,
          axisX: axes[0].path,
          axisY: axes[1].path,
        }),
      });
      const j = (await r.json()) as Record<string, unknown>;
      if (!r.ok) {
        setMsg({ kind: "err", text: String(j.error ?? `HTTP ${r.status}`) });
        return;
      }
      setReport(j.report as SweepReport);
      setMsg({ kind: "ok", text: `扫完 ${(j.report as SweepReport).evaluated} 个点` });
    } catch (e) {
      setMsg({ kind: "err", text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-0.5">
          <span className="text-ink-3 text-[11px]">起</span>
          {/* 与 LabRunner 同一个控件：扫描的每个点都是一次完整回测，区间选错的代价一样 */}
          <DateInput
            className="w-36"
            value={from}
            onChange={setFrom}
            min={defaultRange.from}
            max={to || defaultRange.to}
          />
        </label>
        <label className="flex flex-col gap-0.5">
          <span className="text-ink-3 text-[11px]">止</span>
          <DateInput
            className="w-36"
            value={to}
            onChange={setTo}
            min={from || defaultRange.from}
            max={defaultRange.to}
          />
        </label>
        <label className="flex flex-col gap-0.5">
          <span className="text-ink-3 text-[11px]">初始资金</span>
          <input className={`${inputCls} w-24`} value={cash} onChange={(e) => setCash(e.target.value)} />
        </label>
      </div>

      {axes.map((a, i) => (
        <div key={i} className="flex flex-wrap items-end gap-2">
          <label className="flex flex-col gap-0.5">
            <span className="text-ink-3 text-[11px]">{i === 0 ? "x 轴参数" : "y 轴参数"}</span>
            <select
              className="bg-panel-2 border border-line rounded-sm px-1 py-0.5 text-[12px] text-ink w-64"
              value={a.path}
              onChange={(e) =>
                setAxes((prev) => prev.map((x, k) => (k === i ? { ...x, path: e.target.value } : x)))
              }
            >
              {paramPaths.map((p) => (
                <option key={p} value={p}>{p}</option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-0.5">
            <span className="text-ink-3 text-[11px]">取值（逗号分隔，2~6 个）</span>
            <input
              className={`${inputCls} w-56`}
              placeholder="0.6, 0.7, 0.8"
              value={a.values}
              onChange={(e) =>
                setAxes((prev) => prev.map((x, k) => (k === i ? { ...x, values: e.target.value } : x)))
              }
            />
          </label>
          <span className="text-ink-3 text-[11px]">{counts[i]} 个取值</span>
        </div>
      ))}

      <div className="flex flex-wrap items-center gap-2">
        <button className={btnCls} disabled={busy || from === "" || to === ""} type="button" onClick={() => void measure()}>
          测速（跑 1 次回测）
        </button>
        <button
          className={btnCls}
          disabled={!canRun}
          type="button"
          onClick={() => {
            if (estMs !== null && estMs > 5 * 60_000) {
              if (!confirm(
                `预计 ${fmtDur(estMs)}，这段时间页面会一直卡着（同步跑，刷新即白跑）。继续？\n` +
                `想更快就缩短区间或减少取值个数。`
              )) return;
            }
            void run();
          }}
        >
          {busy ? "扫描中（同步跑，别刷新）…" : "开始扫描"}
        </button>
        <span className={overCap ? "text-danger text-[11px]" : "text-ink-3 text-[11px]"}>
          {points} 个网格点 / 上限 {maxPoints}
          {overCap ? " —— 超了，减少取值个数" : "，每点一次完整回测"}
        </span>
        <span className={estMs !== null && estMs > 5 * 60_000 ? "text-warn text-[11px]" : "text-ink-3 text-[11px]"}>
          {perPointMs === null
            ? "耗时未知 —— 先测速。单点耗时几乎只由区间长度决定，点数上限拦不住它"
            : `预计 ${estMs === null ? "—" : fmtDur(estMs)}（单点 ${(perPointMs / 1000).toFixed(1)}s × ${points}）`}
        </span>
        {badAxis !== undefined && !badAxis.r.ok ? (
          <span className="text-danger text-[11px]">取值 “{badAxis.r.bad}” 不是数字或 true/false</span>
        ) : null}
        {dupPath ? <span className="text-danger text-[11px]">两条轴选了同一个参数</span> : null}
        {msg !== null ? (
          <span className={msg.kind === "ok" ? "text-down text-[12px]" : "text-danger text-[12px]"}>
            {msg.text}
          </span>
        ) : null}
      </div>

      <p className="text-ink-3 text-[11px]">
        扫描同步跑在请求线程里，{maxPoints} 点上限就是为此设的 —— 中途刷新页面等于白跑。
        非法参数组合（越界值等）会在开跑**之前**整体拒绝，不会跑一半留下缺格的图。
      </p>

      {report !== null ? <SweepResult r={report} /> : null}
    </div>
  );
}

function SweepResult({ r }: { r: SweepReport }) {
  const flat = r.heatmap.cells.flat().filter((c): c is number => c !== null);
  const lo = Math.min(...flat);
  const hi = Math.max(...flat);
  /** 颜色只表达"在本次扫描内的相对高低"，不跨扫描比较 —— 跨图比颜色会看出不存在的结论 */
  const shade = (v: number | null) => {
    if (v === null) return { background: "transparent" };
    const t = hi === lo ? 0.5 : (v - lo) / (hi - lo);
    return { background: `color-mix(in srgb, var(--color-down) ${Math.round(t * 70)}%, transparent)` };
  };
  const bestX = r.best.params[r.heatmap.axisX];
  const bestY = r.best.params[r.heatmap.axisY];

  return (
    <div className="flex flex-col gap-2 mt-1">
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 text-[12px]">
        <span className="text-ink-3">最优 Calmar</span>
        <span className="num text-ink">{r.best.metrics.calmar.toFixed(3)}</span>
        <span className="text-ink-3">峰陡度</span>
        <span className={r.peak.overfitRisk ? "num text-danger" : "num text-ink"}>
          {r.peak.sharpness.toFixed(3)}
        </span>
        {r.peak.overfitRisk ? (
          <span className="text-danger border border-danger/60 rounded px-1">
            过拟合风险：邻域均值 {r.peak.neighbourMeanCalmar.toFixed(3)}，只有这一点好
          </span>
        ) : (
          <span className="text-ink-3">邻域均值 {r.peak.neighbourMeanCalmar.toFixed(3)}</span>
        )}
        <span className="text-ink-3">覆盖率</span>
        <span className={r.coverage.coverage < 0.9 ? "num text-warn" : "num text-ink"}>
          {(r.coverage.coverage * 100).toFixed(1)}%
        </span>
        <span className="text-ink-3">缺口 {r.coverage.gapDays} 天</span>
      </div>

      {r.coverage.coverage < 0.9 ? (
        <p className="text-warn text-[11px]">
          覆盖率不足 90%，这张图的颜色深浅不能当结论 ——
          覆盖率 60% 的 Calmar 3.0 不如覆盖率 99% 的 1.5。
        </p>
      ) : null}

      <div className="overflow-x-auto">
        <table className="dense">
          <thead>
            <tr>
              <th className="text-ink-3">
                {r.heatmap.axisY} \ {r.heatmap.axisX}
              </th>
              {r.heatmap.x.map((xv, xi) => (
                <th key={xi} className="num text-right">{fmtAxisValue(xv)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {r.heatmap.y.map((yv, yi) => (
              <tr key={yi}>
                <td className="num text-ink-2">{fmtAxisValue(yv)}</td>
                {r.heatmap.x.map((xv, xi) => {
                  const v = r.heatmap.cells[yi][xi];
                  const isBest = xv === bestX && yv === bestY;
                  return (
                    <td
                      key={xi}
                      className={`num text-right ${isBest ? "text-ink font-medium outline outline-1 outline-down" : "text-ink-2"}`}
                      style={shade(v)}
                      title={v === null ? "未评估" : `Calmar ${v}`}
                    >
                      {v === null ? "—" : v.toFixed(2)}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {hi === lo ? (
        <p className="text-warn text-[11px]">
          所有格子的 Calmar 都是 {lo}，**颜色深浅在这张图里没有任何含义** ——
          参数在这个区间内没有区分度（常见成因：区间太短没成交、或指标退化被记成 0，见下方 warnings）。
        </p>
      ) : null}
      <p className="text-ink-3 text-[11px]">
        单元格是该组合的最好 Calmar，颜色只表示**本次扫描内**的相对高低，不跨扫描比较。
        破折号 = 该组合没评估过（不插值、不补零：没做过的实验不画成结论）。描边格 = 最优点。
      </p>

      {r.sensitivity.length > 0 ? (
        <div className="overflow-x-auto">
          <table className="dense">
            <thead>
              <tr>
                <th>轴</th>
                <th>取值</th>
                <th className="text-right">最好 Calmar</th>
                <th className="text-right">平均 Calmar</th>
              </tr>
            </thead>
            <tbody>
              {r.sensitivity.flatMap((s) =>
                s.points.map((p, k) => (
                  <tr key={`${s.axis}-${k}`}>
                    <td className="text-ink-2">{k === 0 ? s.axis : ""}</td>
                    <td className="num">{fmtAxisValue(p.value)}</td>
                    <td className="num text-right text-ink">{p.bestCalmar.toFixed(3)}</td>
                    <td className="num text-right text-ink-2">{p.meanCalmar.toFixed(3)}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
          <p className="mt-1 text-ink-3 text-[11px]">
            看**平均**那一列比看最好那列更有用：平均随取值平滑变化 = 这条轴稳；
            只有某一个取值的最好值突出而平均很低 = 那是噪音里的尖峰。
          </p>
        </div>
      ) : null}

      {r.warnings.length > 0 ? (
        <ul className="text-warn text-[11px] leading-5">
          {r.warnings.map((w, k) => (
            <li key={k}>· {w}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
