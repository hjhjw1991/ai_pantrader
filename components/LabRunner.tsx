"use client";

import { useRef, useState } from "react";
import type { BacktestReport } from "@/lib/contracts/backtest";
import { BacktestReportView } from "@/components/BacktestReportView";
import { readNdjson } from "@/components/ndjson";
import { DateInput } from "@/components/DateInput";

/**
 * 回测执行控件。只在回测层就绪时才被渲染（见 lab 页）。
 *
 * 失败时把后端原因原样显示，不退化成"暂无数据" —— 回测跑失败和回测跑出空结果
 * 是两件事，后者才可能意味着策略在该区间没交易。
 */
/**
 * 下拉里两类东西并排，用前缀区分：
 *   s:<id>@<版本>  策略快照（strategy 表，YAML 的历史原文）
 *   v:<变体 id>    影子盘的组合（shadow_variant 表，五个槽位的一套搭配）
 * 合成一个下拉而不是两个框：两者互斥（一次回测跑一套东西），两个框会让人以为能各选一个。
 */
const SNAP = "s:";
const VARIANT = "v:";

export function LabRunner({
  strategies,
  variants,
  defaultRange,
}: {
  strategies: Array<{ id: string; version: string }>;
  variants: Array<{ id: string; name: string; status: string }>;
  defaultRange: { from: string; to: string };
}) {
  const [sel, setSel] = useState(() => {
    const s = strategies[0];
    return s ? `${SNAP}${s.id}@${s.version}` : "";
  });
  const [from, setFrom] = useState(defaultRange.from);
  const [to, setTo] = useState(defaultRange.to);
  // 初始资金没有默认值：它决定手数取整能不能成交、单票占比是多少。
  // 替用户假设账户规模会让成交笔数与占比全都偏。
  const [cash, setCash] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [report, setReport] = useState<BacktestReport | null>(null);
  /** 服务端回执的"这次跑的是谁"。报告信封里只有 strategyId，分不出组合 */
  const [label, setLabel] = useState<string | null>(null);
  /** 回放进度。total=0 表示还没收到第一天 */
  const [prog, setProg] = useState<{ done: number; total: number; date: string }>(
    { done: 0, total: 0, date: "" }
  );
  const startedAt = useRef(0);
  // 取消靠中断请求：服务端收到 abort 就在下一个交易日之间停手，不会留下跑一半的报告
  const abortRef = useRef<AbortController | null>(null);

  const inputCls = "num bg-panel-2 border border-line-2 rounded-sm px-2 py-1 text-ink";

  return (
    <div className="flex flex-col gap-3">
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={async (e) => {
          e.preventDefault();
          // 已有一个在跑就不开新的。服务端也挡（409），这里挡是为了不白发一次请求
          if (abortRef.current !== null) return;
          const ac = new AbortController();
          abortRef.current = ac;
          startedAt.current = Date.now();
          setBusy(true);
          setErr(null);
          setReport(null);
          setLabel(null);
          setProg({ done: 0, total: 0, date: "" });
          try {
            // 先说清楚跑的是哪一套，再发请求：服务端是按这两个字段挑配置的
            const raw = sel.slice(2);
            const body: Record<string, unknown> = { from, to, initialCash: Number(cash) };
            if (sel.startsWith(VARIANT)) body.variantId = raw;
            else {
              const at = raw.lastIndexOf("@");
              body.strategyId = raw.slice(0, at);
              body.strategyVersion = raw.slice(at + 1);
            }
            const r = await fetch("/api/backtest", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(body),
              signal: ac.signal,
            });

            const outcome = await readNdjson(r, ev => {
              if (ev.phase === "start") setLabel(typeof ev.label === "string" ? ev.label : null);
              if (ev.phase === "day") {
                setProg({
                  done: Number(ev.done ?? 0),
                  total: Number(ev.total ?? 0),
                  date: String(ev.date ?? ""),
                });
              }
            });
            // 参数不合法 / 已有重活在跑 / 策略配置不可用：这些在开跑之前就返回，是普通 JSON
            if (outcome.kind === "rejected") throw new Error(outcome.error);
            const last = outcome.last;

            // 结论只能从消息体里读：流式响应的状态码在第一个字节就定死了
            if (last?.phase === "done") setReport(last.report as BacktestReport);
            else if (last?.phase === "aborted") setErr(String(last.reason ?? "已取消"));
            else throw new Error(String(last?.reason ?? "回测中断，未收到结束消息"));
          } catch (e2) {
            // 自己点的取消不算错误
            if ((e2 as Error).name === "AbortError") setErr("已取消");
            else setErr((e2 as Error).message);
          } finally {
            abortRef.current = null;
            setBusy(false);
          }
        }}
      >
        <label className="flex flex-col gap-0.5">
          <span className="text-ink-3 text-[11px]">跑哪一套</span>
          <select
            className={`${inputCls} w-60`}
            value={sel}
            onChange={(e) => setSel(e.target.value)}
            required
          >
            <optgroup label="策略快照">
              {strategies.map((s) => (
                <option key={`${SNAP}${s.id}@${s.version}`} value={`${SNAP}${s.id}@${s.version}`}>
                  {s.id} @ {s.version}
                </option>
              ))}
            </optgroup>
            {variants.length > 0 ? (
              <optgroup label="影子盘组合（槽位搭配）">
                {variants.map((v) => (
                  <option key={`${VARIANT}${v.id}`} value={`${VARIANT}${v.id}`}>
                    {v.name}
                    {v.status !== "active" ? "（已退役）" : ""}
                  </option>
                ))}
              </optgroup>
            ) : null}
          </select>
        </label>
        <label className="flex flex-col gap-0.5">
          <span className="text-ink-3 text-[11px]">起始日</span>
          {/* 上下界卡在库里真有交易日历的区间；再用 to 卡住 from，反过来的区间在控件上就选不出来 */}
          <DateInput
            className="w-36"
            value={from}
            onChange={setFrom}
            min={defaultRange.from}
            max={to || defaultRange.to}
            required
          />
        </label>
        <label className="flex flex-col gap-0.5">
          <span className="text-ink-3 text-[11px]">结束日</span>
          <DateInput
            className="w-36"
            value={to}
            onChange={setTo}
            min={from || defaultRange.from}
            max={defaultRange.to}
            required
          />
        </label>
        <label className="flex flex-col gap-0.5">
          <span className="text-ink-3 text-[11px]">初始资金（元，必填）</span>
          <input
            className={`${inputCls} w-32`}
            value={cash}
            onChange={(e) => setCash(e.target.value)}
            inputMode="numeric"
            placeholder="必填"
            required
          />
        </label>
        <button
          type="submit"
          className="border border-line-2 rounded-sm px-3 py-1 text-ink-2 hover:text-ink disabled:opacity-40"
          disabled={busy || !sel || !(Number(cash) > 0)}
        >
          {busy ? "回放中…" : "开始回测"}
        </button>
        {busy ? (
          <button
            type="button"
            onClick={() => abortRef.current?.abort()}
            className="border border-danger/60 rounded-sm px-3 py-1 text-danger hover:bg-danger/10"
          >
            取消
          </button>
        ) : null}
        {err ? <span className="text-danger">{err}</span> : null}
      </form>

      <BacktestProgress busy={busy} prog={prog} startedAt={startedAt.current} />

      {sel.startsWith(VARIANT) ? (
        <p className="text-ink-3 text-[11px]">
          选的是影子盘组合：回测会把这套槽位搭配盖在当前策略上跑一遍历史，
          <span className="text-warn">成绩只作参考，不算毕业依据</span> ——
          毕业看的是影子盘的实盘样本（同一段行情上真出过的信号），座次表在影子盘抽屉。
        </p>
      ) : null}

      {report ? (
        <div className="flex flex-col gap-2">
          {label ? (
            <p className="text-ink-2 text-[11px]">
              本次跑的是 <span className="text-ink">{label}</span>
            </p>
          ) : null}
          <BacktestReportView report={report} />
        </div>
      ) : null}
    </div>
  );
}

/**
 * 回测进度条。
 *
 * 显示剩余时间而不只是百分比：四年跨度实测约 6 分钟，人要的是"还要等多久"，
 * 而不是"32%"。估算用**已跑出来的实际速度**外推，不用写死的每日耗时 ——
 * 每日耗时取决于机器和标的池大小，写死的数字换台机器就开始撒谎。
 *
 * 头几天不给估算：样本太少时外推出来的剩余时间会剧烈跳动，
 * 一会儿 2 分钟一会儿 20 分钟，比不显示更让人烦躁。
 */
function BacktestProgress({
  busy,
  prog,
  startedAt,
}: {
  busy: boolean;
  prog: { done: number; total: number; date: string };
  startedAt: number;
}) {
  if (!busy) return null;

  const pct = prog.total > 0 ? Math.round((prog.done / prog.total) * 100) : null;
  const elapsedMs = startedAt > 0 ? Date.now() - startedAt : 0;
  const perDay = prog.done > 0 ? elapsedMs / prog.done : 0;
  const leftSec = prog.done >= 5 && prog.total > 0
    ? Math.round((perDay * (prog.total - prog.done)) / 1000)
    : null;
  const fmtLeft = (s: number) =>
    s >= 60 ? `约 ${Math.floor(s / 60)} 分 ${String(s % 60).padStart(2, "0")} 秒` : `约 ${s} 秒`;

  return (
    <div className="flex flex-col gap-1">
      <div className="h-1 w-full rounded-sm bg-panel-2 overflow-hidden">
        <div
          className={pct === null ? "h-full w-1/4 bg-info animate-pulse" : "h-full bg-info"}
          style={pct === null ? undefined : { width: `${pct}%` }}
        />
      </div>
      <span className="text-ink-3 text-[11px] num">
        {pct === null
          ? "正在取交易日历…"
          : `回放 ${prog.done}/${prog.total} 个交易日（${pct}%）`
            + (prog.date ? ` · 当前 ${prog.date}` : "")
            + (leftSec !== null ? ` · 预计还需${fmtLeft(leftSec)}` : "")}
      </span>
    </div>
  );
}
