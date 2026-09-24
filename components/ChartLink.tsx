"use client";

import type { PlanLevels } from "@/components/StockChart";

/** 作战台里的"看图"：不跳页，直接让右侧 K 线换成这只票，并带上计划价位 */
export const CHART_EVENT = "pt:chart";
export interface ChartRequest { code: string; levels?: PlanLevels }

export function openChart(req: ChartRequest): void {
  window.dispatchEvent(new CustomEvent<ChartRequest>(CHART_EVENT, { detail: req }));
  const el = document.getElementById("chart");
  // 窄屏时图在下方，要滚过去；宽屏图固定在右栏，已经看得见就不动
  if (el) {
    const r = el.getBoundingClientRect();
    if (r.top > window.innerHeight || r.bottom < 0) el.scrollIntoView({ behavior: "smooth", block: "start" });
  }
}

export function ChartLink({ code, levels, label = "看图" }: ChartRequest & { label?: string }) {
  return (
    <button type="button" className="ml-1 text-info text-[10px] hover:underline" title="在 K 线图里看结构位与计划价位"
      onClick={() => openChart({ code, ...(levels ? { levels } : {}) })}>
      {label}
    </button>
  );
}
