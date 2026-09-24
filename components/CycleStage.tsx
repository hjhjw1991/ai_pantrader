import type { StageView } from "@/lib/ui/adapters/overview";
import { Tag } from "@/components/Panel";

/**
 * 情绪阶段灯。与档位灯并排：档位是"今天能不能买"，阶段是"现在处在周期的哪一段"。
 *
 * 阶段对所有人都一样，不管正式策略的择时器用不用它 —— 所以这里要说清正式策略有没有按它定档，
 * 否则人看见"启动"却发现档位还是中性，会以为系统坏了。
 */

const TONE: Record<string, string> = {
  冰点: "text-info", 启动: "text-up", 发酵: "text-up", 高潮: "text-warn", 退潮: "text-down",
};
const ORDER = ["冰点", "启动", "发酵", "高潮", "退潮"];

export function CycleStageLight({ s, timerInUse }: { s: StageView; timerInUse: boolean }) {
  const inputs = (s.factor.inputs ?? {}) as Record<string, any>;
  const parts = (inputs["分项分位"] ?? {}) as Record<string, number | null>;
  const track = (inputs["轨迹"] ?? []) as Array<{ 日期: string; 阶段: string | null; 热度: number | null }>;
  return (
    <div>
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className={`text-2xl font-medium whitespace-nowrap ${s.stage ? TONE[s.stage] : "text-ink-3"}`}>{s.stage ?? s.label}</span>
        {s.stage ? (
          <span className="text-ink-2 whitespace-nowrap">
            已持续 <span className="num text-ink">{s.days ?? "—"}</span> 天 · 热度 <span className="num text-ink">{s.heat === null ? "—" : s.heat.toFixed(2)}</span>
          </span>
        ) : (
          <span className="text-ink-3">情绪派生表未就绪或样本不足，阶段判不出来</span>
        )}
        <span className="text-[11px] text-ink-3 whitespace-nowrap">按 {s.date} 收盘</span>
      </div>

      {/* 五段刻度：当前段高亮 */}
      <div className="mt-2 flex gap-1">
        {ORDER.map(k => (
          <span key={k} className={`flex-1 text-center text-[11px] rounded-sm border px-1 py-0.5 ${
            k === s.stage ? `border-current ${TONE[k]} bg-panel-2` : "border-line text-ink-3"}`}>{k}</span>
        ))}
      </div>

      {track.length > 0 ? (
        <div className="mt-2 flex flex-wrap gap-1 text-[11px]">
          {track.map(t => (
            <span key={t.日期} title={`${t.日期} 热度 ${t.热度 ?? "—"}`}
              className={`border border-line rounded-sm px-1 ${t.阶段 ? TONE[t.阶段] : "text-ink-3"}`}>
              {t.日期.slice(5)} {t.阶段 ?? "—"}
            </span>
          ))}
        </div>
      ) : null}

      {Object.keys(parts).length > 0 ? (
        <div className="mt-2 grid grid-cols-1 gap-y-0.5 text-[11px]">
          {Object.entries(parts).map(([k, v]) => (
            <div key={k} className="flex items-center gap-2">
              <span className="text-ink-2 w-20 shrink-0">{k}</span>
              <span className="flex-1 h-1.5 bg-panel-2 rounded-sm overflow-hidden">
                {v === null ? null : <span className="block h-full bg-info/70" style={{ width: `${Math.round(v * 100)}%` }} />}
              </span>
              <span className="num w-8 text-right">{v === null ? "—" : v.toFixed(2)}</span>
            </div>
          ))}
        </div>
      ) : null}

      <p className="mt-2 text-[11px] text-ink-3">
        {timerInUse
          ? "正式策略按这个阶段定档位（五段状态机择时器）。"
          : "正式策略目前不按阶段定档（择时器是三档阈值）；阶段只作参考，影子盘里有按阶段择时的组合在比。"}
        {" "}<Tag tone="warn">proxy</Tag> 分项由日线与涨停池重建，阈值由近一年自身分布学出。
      </p>
    </div>
  );
}
