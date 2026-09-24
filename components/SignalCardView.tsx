import type { Candidate, EnvAssessment, SignalCard } from "@/lib/contracts/strategy";
import type { FactorResult } from "@/lib/contracts/factor";
import { Num } from "@/components/Num";
import { KV, Tag } from "@/components/Panel";
import { NoRows } from "@/components/EmptyState";
import { gearClass } from "@/lib/ui/format";
import type { PricingRef } from "@/lib/ui/adapters/overview";

/**
 * 信号卡渲染。
 *
 * 两条不可省的展示规则：
 *  1. 低置信因子必须**和结论并列显示**，不折叠 —— 情绪类因子是日线代理重建，
 *     不是真值（spec §10.3）。看到"进攻档"却看不到它建立在 ρ 未验证的代理值上，
 *     就会把它当确定结论。
 *  2. warnings（数据缺口/覆盖率）必须上卡（spec §10.5），不能只写进日志。
 */

export function GearLight({ env }: { env: EnvAssessment }) {
  return (
    <div>
      <div className="flex items-baseline gap-3">
        <span className={`text-2xl font-medium ${gearClass(env.gear)}`}>{env.gear}</span>
        <span className="text-ink-2">
          目标总仓位 <span className="num text-ink">{(env.targetPosition * 100).toFixed(0)}%</span>
        </span>
        {env.gear === "防守" ? (
          <Tag tone="down">防守 = 0 仓，不是轻仓</Tag>
        ) : null}
      </div>

      {env.reasons.length > 0 ? (
        <ul className="mt-2 list-disc pl-4 text-[12px] text-ink-2 leading-6">
          {env.reasons.map((r, i) => (
            <li key={i}>{r}</li>
          ))}
        </ul>
      ) : (
        <p className="mt-2 text-ink-3">引擎未给出档位归因。</p>
      )}

      {env.lowConfidenceFactors.length > 0 ? (
        <div className="mt-2 border border-warn/50 bg-warn/5 rounded-sm px-2 py-1">
          <span className="text-warn">低置信因子参与了这个档位判断：</span>
          <span className="num text-ink-2 ml-1">{env.lowConfidenceFactors.join(" ")}</span>
          <p className="text-ink-3 text-[11px] mt-0.5">
            情绪类因子由日线代理重建，不是真值。满 60 交易日后跑 proxy-vs-real 相关性审计，
            ρ&lt;0.8 的因子结论天然带误差。
          </p>
        </div>
      ) : null}

      {env.factors.length > 0 ? <FactorTable factors={env.factors} /> : null}
    </div>
  );
}

export function FactorTable({ factors }: { factors: FactorResult<unknown>[] }) {
  return (
    <div className="mt-2 overflow-x-auto max-h-64 overflow-y-auto">
      <table className="dense">
        <thead>
          <tr>
            <th>因子</th>
            <th>版本</th>
            <th className="text-right">值</th>
            <th>标签</th>
            <th>来源</th>
            <th className="text-right">置信</th>
          </tr>
        </thead>
        <tbody>
          {factors.map((f) => (
            <tr key={`${f.name}@${f.version}`}>
              <td className="text-ink">{f.name}</td>
              <td className="num text-ink-3">{f.version}</td>
              <td className="num">
                {typeof f.value === "number" ? (
                  <Num v={f.value} digits={3} />
                ) : (
                  <span className="text-ink-2">{String(f.value)}</span>
                )}
              </td>
              <td className="text-ink-2">{f.label ?? "—"}</td>
              <td>
                {/* proxy = 代理重建，不是真值。这个标签不许省 */}
                {f.provenance === "proxy" ? <Tag tone="warn">proxy</Tag> : <Tag>real</Tag>}
              </td>
              <td className="num">
                <span className={f.confidence < 0.8 ? "text-warn" : "text-ink"}>
                  {f.confidence.toFixed(2)}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function CandidateTable({
  rows,
  emptyWhat,
  emptyHint,
  pricing,
}: {
  rows: Candidate[];
  emptyWhat: string;
  emptyHint?: string;
  /** 目标位与盈亏比。给了才出这两列；正式组合不带定价时是界面补的参考值 */
  pricing?: Map<string, PricingRef>;
}) {
  if (rows.length === 0) return <NoRows what={emptyWhat} hint={emptyHint} />;
  return (
    <div className="overflow-x-auto">
      <table className="dense">
        <thead>
          <tr>
            <th>代码</th>
            <th>名称</th>
            <th>动作</th>
            <th>账户</th>
            <th className="text-right">触发价</th>
            <th className="text-right">止损价</th>
            <th className="text-right">计划亏损</th>
            {pricing ? <th className="text-right" title="优先取前高，前高已被突破或没有前高时用触发价 + 3×ATR">目标价</th> : null}
            {pricing ? <th className="text-right" title="(目标 − 触发) ÷ (触发 − 止损)">盈亏比</th> : null}
            <th className="text-right">建议仓位</th>
            <th className="text-right">评分</th>
            <th>逻辑</th>
            <th>命中过滤器</th>
            <th>低置信</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((c) => {
            // 触发价买入到止损的距离 = 这一单的最大计划亏损，必须在下单前就看得见
            const plannedLoss =
              c.triggerPx !== null && c.stopPx !== null && c.triggerPx > 0
                ? (c.stopPx - c.triggerPx) / c.triggerPx
                : null;
            const lowConf = c.factors.filter((f) => f.confidence < 0.8).map((f) => f.name);
            return (
              <tr key={`${c.account}-${c.code}`}>
                <td className="num text-ink">
                  {c.code}
                  <a className="ml-1 text-info text-[10px]" title="在下方 K 线图里看结构位与计划价位"
                    href={chartHref(c.code, { trigger: c.triggerPx, stop: c.stopPx, target: pricing?.get(c.code)?.targetPx ?? null })}>看图</a>
                </td>
                <td>{c.name}</td>
                <td>
                  <ActionTag action={c.action} />
                </td>
                <td className="text-ink-2">{c.account}</td>
                <td className="num">
                  <Num v={c.triggerPx} />
                </td>
                <td className="num">
                  <Num v={c.stopPx} />
                </td>
                <td className="num">
                  <Num v={plannedLoss} kind="ratio" dir />
                </td>
                {pricing ? <PricingCells p={pricing.get(c.code)} /> : null}
                <td className="num">
                  <Num v={c.size} kind="ratio" />
                </td>
                <td className="num">
                  <Num v={c.score} digits={1} />
                </td>
                <td className="text-ink-2 max-w-[24rem] truncate" title={c.thesis}>
                  {c.thesis || "—"}
                </td>
                <td className="text-ink-3 max-w-[16rem] truncate" title={c.passedFilters.join(" / ")}>
                  {c.passedFilters.length ? c.passedFilters.join(" ") : "—"}
                </td>
                <td className="text-warn max-w-[12rem] truncate" title={lowConf.join(" ")}>
                  {lowConf.length ? lowConf.join(" ") : "—"}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** 页面内跳到 K 线图并带上计划价位（服务端从 searchParams 读） */
export function chartHref(code: string, lv: { trigger?: number | null; stop?: number | null; target?: number | null; cost?: number | null }): string {
  const q = new URLSearchParams({ chart: code });
  for (const [k, v] of [["trig", lv.trigger], ["stop", lv.stop], ["tgt", lv.target], ["cost", lv.cost]] as const) {
    if (typeof v === "number" && Number.isFinite(v)) q.set(k, String(v));
  }
  return `?${q.toString()}#chart`;
}

/** 目标价与盈亏比两格。参考值（正式组合没用它选股）标一个"参考"，盈亏比不到 1.5 标黄 */
function PricingCells({ p }: { p: PricingRef | undefined }) {
  if (p === undefined) return (<><td className="num">—</td><td className="num">—</td></>);
  return (
    <>
      <td className="num" title={p.source}>
        <Num v={p.targetPx} />
        {!p.formal && p.targetPx !== null ? <span className="ml-1 text-ink-3 text-[10px]">参考</span> : null}
      </td>
      <td className={`num ${p.rrRatio !== null && p.rrRatio < 1.5 ? "text-warn" : p.rrRatio !== null && p.rrRatio >= 3 ? "text-up" : ""}`}
        title={p.rrRatio === null ? "没有止损价，盈亏比算不出" : p.source}>
        {p.rrRatio === null ? "—" : p.rrRatio.toFixed(2)}
      </td>
    </>
  );
}

export function ActionTag({ action }: { action: Candidate["action"] }) {
  if (action === "买入" || action === "加仓") return <Tag tone="up">{action}</Tag>;
  if (action === "清仓" || action === "减仓") return <Tag tone="down">{action}</Tag>;
  return <Tag>{action}</Tag>;
}

/** 数据覆盖率警告：有缺口就必须出现在卡上（契约注释里写死的要求） */
export function CardWarnings({ card }: { card: SignalCard }) {
  if (card.warnings.length === 0) return null;
  return (
    <div className="border border-warn/60 bg-warn/5 rounded-sm px-3 py-2">
      <div className="text-warn font-medium">信号卡警告 {card.warnings.length} 条</div>
      <ul className="mt-1 list-disc pl-4 text-[12px] text-ink-2 leading-6">
        {card.warnings.map((w, i) => (
          <li key={i}>{w}</li>
        ))}
      </ul>
    </div>
  );
}

export function CardMeta({
  card,
  universe,
}: {
  card: SignalCard;
  universe: { total: number; unknownListDate: number; unknownRatio: number };
}) {
  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-x-6">
      <KV label="时段">{card.phase}</KV>
      <KV label="策略" hint={`归因键 ${card.strategyId} —— 台账按它分组，不随改名变化`}>
        {card.strategyName}
      </KV>
      <KV label="Advisor 改过">{card.advisorInfluenced ? "是" : "否"}</KV>
      <KV label="在市标的" hint={`${universe.unknownListDate} 只上市日未知`}>
        <Num v={universe.total} kind="int" />
      </KV>
    </div>
  );
}
