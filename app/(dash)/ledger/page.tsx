import { NoDatabase, NoRows } from "@/components/EmptyState";
import { Num } from "@/components/Num";
import { KV, Panel, Tag } from "@/components/Panel";
import { dbUnavailable, readDb } from "@/lib/ui/db";
import { fmtTs } from "@/lib/ui/format";
import { dashboard, paramSuggestions, winRateStats } from "@/lib/ui/adapters/ledger";
import { predictionTimeline } from "@/lib/ui/queries";
import { shanghaiParts } from "@/lib/ui/status";

export const dynamic = "force-dynamic";

/**
 * 台账 / 胜率。spec §13：命中率仪表盘、错误类型分布、预测 vs 实际时间线。
 *
 * 统计口径全部来自 lib/ledger，前端不自己算 —— winrate / dashboard / suggest
 * 三处口径必须一致，前端再算一遍就是第四个口径。
 *
 * 最要紧的一条：**没有已结算样本时不显示 0%**。0% 会被读成"策略已失效"，
 * 而真相是"还没有一条预测到期对过账"，两者的处置动作完全相反。
 */
export default function LedgerPage() {
  const db = readDb();
  if (!db) return <NoDatabase why={dbUnavailable()} />;

  const today = shanghaiParts(new Date()).date;
  const stats = winRateStats(db);
  const dash = dashboard(db, today);
  const suggestions = paramSuggestions(db);
  const timeline = predictionTimeline(db, 200);

  const errorRows = dash.byErrorType.filter((e) => e.count > 0);
  const maxErr = errorRows.reduce((m, e) => Math.max(m, e.count), 0);

  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
        <Panel
          title="命中率仪表盘"
          hint="分母 = 全部已结算预测（含中性），不挑样本"
          right={`已结算 ${dash.pending.settled} 条 · 待结算 ${dash.pending.pending}`}
        >
          {stats === null ? (
            <NoRows
              what="还没有已结算的预测"
              hint="预测由信号引擎写 prediction，到期由对账 job 写 outcome。此处不显示 0% —— 无样本不是 0% 命中"
            />
          ) : (
            <>
              <KV label="总命中率">
                <Num v={stats.rate} kind="ratio" />
              </KV>
              <KV label="命中 / 已结算">
                {stats.hit} / {stats.total}
              </KV>
              {(["盘前", "盘中", "盘后"] as const).map((p) => {
                const b = stats.byPhase[p];
                return (
                  <KV key={p} label={`${p}命中率`} hint={`${b.hit}/${b.total}`}>
                    <Num v={b.total > 0 ? b.hit / b.total : null} kind="ratio" />
                  </KV>
                );
              })}
              <KV label="中性（不算命中也不算偏差）">
                <Num v={stats.neutral} kind="int" />
              </KV>
              {dash.pending.overdueUnsettled > 0 ? (
                <p className="mt-2 text-warn text-[11px]">
                  有 {dash.pending.overdueUnsettled} 条预测已过 valid_until 却未结算 ——
                  多半是对账拿不到真价。未结算样本不进胜率，会让统计偏乐观。
                </p>
              ) : null}
            </>
          )}
        </Panel>

        <Panel title="Advisor A/B" hint="Claude 改过的信号 vs 没改过的（spec §5.3）">
          {stats === null ? (
            <NoRows what="无已结算样本" />
          ) : (
            <>
              <KV
                label="有 Advisor 参与"
                hint={`${stats.advisorAB.with.hit}/${stats.advisorAB.with.total}`}
              >
                <Num v={stats.ab.withRate} kind="ratio" />
              </KV>
              <KV
                label="无 Advisor 参与"
                hint={`${stats.advisorAB.without.hit}/${stats.advisorAB.without.total}`}
              >
                <Num v={stats.ab.withoutRate} kind="ratio" />
              </KV>
              <KV label="差值（百分点）" hint={`每臂至少需 ${stats.ab.minSamplePerArm} 条`}>
                <Num v={stats.ab.deltaPct} kind="pct" dir />
              </KV>
              {/* comparable=false 时台账层不给差值。前端也不许自己相除凑一个出来 */}
              <p className={`mt-2 text-[11px] ${stats.ab.comparable ? "text-ink-3" : "text-warn"}`}>
                {stats.ab.note}
              </p>
            </>
          )}
        </Panel>

        <Panel
          title="参数调整建议"
          hint="某类错误高频 → 建议收紧对应参数。只出建议，不自动改 YAML"
          right={`${suggestions.length} 条`}
        >
          {suggestions.length === 0 ? (
            <NoRows
              what="暂无建议"
              hint="需要同一类错误累计到阈值次数才会出建议；样本不足时不猜"
            />
          ) : (
            <div className="flex flex-col gap-2">
              {suggestions.map((s, i) => (
                <div key={i} className="border border-warn/50 rounded-sm px-2 py-1">
                  <div className="flex items-baseline gap-2">
                    <Tag tone="warn">{s.errorType}</Tag>
                    <span className="num text-ink-2">{s.occurrences} 次</span>
                  </div>
                  <div className="mt-1 text-[12px]">
                    <span className="text-ink-2">{s.paramPath}</span>
                    <span className="num text-ink-3 mx-1">{String(s.current)}</span>
                    <span className="text-ink-3">→</span>
                    <span className="num text-up ml-1">{String(s.suggested)}</span>
                  </div>
                  <p className="text-ink-3 text-[11px] mt-0.5">{s.rationale}</p>
                </div>
              ))}
              <p className="text-ink-3 text-[11px]">
                改参请编辑 config/strategy.yaml（唯一真相源）。系统不会自己动它。
              </p>
            </div>
          )}
        </Panel>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        <Panel title="错误类型分布" hint="固定枚举，不许自由文本 —— 否则频次统计没有意义">
          {maxErr === 0 ? (
            <NoRows what="已结算样本里没有标注错误类型的记录" />
          ) : (
            <div className="flex flex-col gap-1">
              {errorRows.map((e) => (
                <div key={e.errorType} className="flex items-center gap-2">
                  <span className="w-24 text-ink-2 shrink-0">{e.errorType}</span>
                  <div className="grow bg-panel-2 h-3 rounded-sm overflow-hidden">
                    <div
                      className="h-full bg-warn/70"
                      style={{ width: `${(e.count / maxErr) * 100}%` }}
                    />
                  </div>
                  <span className="num w-10 text-ink">{e.count}</span>
                </div>
              ))}
            </div>
          )}
          <p className="mt-2 text-ink-3 text-[11px]">
            四类来自真实复盘：瞬时价误判（用了旧缓存价）/ 板块漏扫（主线在必查链里但没扫到）/
            逆势扛（破止损没走）/ 追高（在位置涨幅上限外买入）。
          </p>
        </Panel>

        <Panel title="按标的的命中率" hint="哪些票上反复判错，比总命中率更能指出问题">
          {dash.byStock.length === 0 ? (
            <NoRows what="无已结算样本" />
          ) : (
            <div className="overflow-x-auto max-h-64 overflow-y-auto">
              <table className="dense">
                <thead>
                  <tr>
                    <th>代码</th>
                    <th className="text-right">命中/总数</th>
                    <th className="text-right">命中率</th>
                  </tr>
                </thead>
                <tbody>
                  {dash.byStock.slice(0, 30).map((s) => (
                    <tr key={s.code}>
                      <td className="num text-ink">{s.code}</td>
                      <td className="num text-ink-2">
                        {s.hit}/{s.total}
                      </td>
                      <td className="num">
                        <Num v={s.total > 0 ? s.hit / s.total : null} kind="ratio" />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>
      </div>

      <Panel
        title="预测 vs 实际"
        hint="判定期限对齐龙虎榜的 D1/D5/D10/D20/D30"
        right={`${timeline.length} 条`}
      >
        {timeline.length === 0 ? (
          <NoRows
            what="prediction 表无记录"
            hint="信号引擎每出一条预测会写入 prediction；作战台看得到卡，但落台账由 lib/ledger/record 负责"
          />
        ) : (
          <div className="overflow-x-auto max-h-[32rem] overflow-y-auto">
            <table className="dense">
              <thead>
                <tr>
                  <th className="text-right">时间</th>
                  <th>时段</th>
                  <th>代码</th>
                  <th>动作</th>
                  <th>账户</th>
                  <th>档位</th>
                  <th className="text-right">触发价</th>
                  <th className="text-right">止损价</th>
                  <th className="text-right">期限</th>
                  <th>Advisor</th>
                  <th>判定</th>
                  <th className="text-right">实际涨跌</th>
                  <th>错误类型</th>
                  <th>归因</th>
                </tr>
              </thead>
              <tbody>
                {timeline.map((t) => (
                  <tr key={t.prediction.id}>
                    <td className="num text-ink-2">{fmtTs(t.prediction.ts, true)}</td>
                    <td className="text-ink-2">{t.prediction.phase}</td>
                    <td className="num text-ink">{t.prediction.code}</td>
                    <td>{t.prediction.action}</td>
                    <td className="text-ink-2">{t.prediction.account}</td>
                    <td className="text-ink-2">{t.prediction.gear}</td>
                    <td className="num">
                      <Num v={t.prediction.triggerPx} />
                    </td>
                    <td className="num">
                      <Num v={t.prediction.stopPx} />
                    </td>
                    <td className="num text-ink-2">D{t.prediction.evalHorizon}</td>
                    <td>{t.prediction.advisorInfluenced ? <Tag tone="info">改过</Tag> : "—"}</td>
                    <td>
                      {t.outcome === null ? (
                        <Tag>未结算</Tag>
                      ) : t.outcome.verdict === "命中" ? (
                        <Tag tone="up">命中</Tag>
                      ) : t.outcome.verdict === "偏差" ? (
                        <Tag tone="danger">偏差</Tag>
                      ) : (
                        <Tag>中性</Tag>
                      )}
                    </td>
                    <td className="num">
                      {/* 未结算时是 null，显示破折号；绝不显示 0% */}
                      <Num v={t.outcome?.actualPct ?? null} kind="pct" dir />
                    </td>
                    <td className="text-ink-2">{t.outcome?.errorType ?? "—"}</td>
                    <td
                      className="text-ink-3 max-w-[20rem] truncate"
                      title={t.outcome?.attribution ?? ""}
                    >
                      {t.outcome?.attribution || "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <p className="text-ink-3 text-[11px]">
        诚实定义：这套闭环不是模型自训练，是规则库 + 参数随实盘对账进化。
        目标是"错误不重犯"，不承诺神预测。
      </p>
    </div>
  );
}
