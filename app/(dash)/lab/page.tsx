import { EmptyState, NoDatabase, NoRows } from "@/components/EmptyState";
import { Num } from "@/components/Num";
import { KV, Panel, Tag } from "@/components/Panel";
import { LabRunner } from "@/components/LabRunner";
import { dbPath, readDb } from "@/lib/ui/db";
import { fmtTs } from "@/lib/ui/format";
import { unavailable } from "@/lib/ui/derive";
import { flattenConfig, readStrategyConfig, STRATEGY_YAML_REL } from "@/lib/ui/adapters/strategy";
import { calendarRange, strategies, tableCounts } from "@/lib/ui/queries";
import { DEFAULT_CONSTRAINTS } from "@/lib/contracts/backtest";

export const dynamic = "force-dynamic";

/**
 * 回测实验室。spec §13：选策略 + 调参 → 跑回测 → 净值/回撤/参数热力图/覆盖率。
 *
 * 回测器（lib/backtest）还不存在，所以"跑"这个动作现在是禁用的，
 * 并且**不渲染任何示例净值曲线**。假的净值曲线是这套系统里最危险的产物：
 * 它会被直接当成策略成绩，而策略成绩决定投多少钱。
 *
 * 但可以先把跑回测的前置条件摆清楚：可用区间、覆盖率原料、约束默认值。
 */
export default function LabPage() {
  const db = readDb();
  if (!db) return <NoDatabase path={dbPath()} />;

  const cfg = readStrategyConfig();
  const strats = strategies(db);
  const cal = calendarRange(db);
  const counts = tableCounts(db);
  const count = (t: string) => counts.find((c) => c.table === t)?.rows ?? -1;

  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        <Panel title="选策略" hint="多策略并存，每个策略有 id + 语义化版本">
          {strats.length === 0 ? (
            <NoRows
              what="strategy 表无记录"
              hint={`策略由 ${STRATEGY_YAML_REL} 定义并由策略层写入 strategy 表（改参自动存版本快照）`}
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="dense">
                <thead>
                  <tr>
                    <th>id</th>
                    <th>版本</th>
                    <th>状态</th>
                    <th className="text-right">创建时间</th>
                    <th className="text-right">因子锁</th>
                  </tr>
                </thead>
                <tbody>
                  {strats.map((s) => (
                    <tr key={`${s.id}-${s.version}`}>
                      <td className="num text-ink">{s.id}</td>
                      <td className="num">{s.version}</td>
                      <td>{s.active ? <Tag tone="up">启用</Tag> : <Tag>历史</Tag>}</td>
                      <td className="num text-ink-3">{fmtTs(s.createdAt, true)}</td>
                      <td className="num text-ink-2">
                        {s.factorsLock ? Object.keys(s.factorsLock).length : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>

        <Panel
          title="调参"
          hint="参数面板是 YAML 的投影（D7），改动写回 YAML，不存在第二份状态"
        >
          {!cfg.available ? (
            <EmptyState u={cfg} compact />
          ) : (
            <>
              <p className="text-warn text-[11px] mb-2">
                只读展示。写回需 lib/strategy/loader.ts（未就绪）—— 现在请直接编辑{" "}
                <code className="text-ink-2">{STRATEGY_YAML_REL}</code>，它本身就是真相源。
              </p>
              <div className="max-h-60 overflow-y-auto">
                <table className="dense">
                  <thead>
                    <tr>
                      <th>参数路径</th>
                      <th className="text-right">当前值</th>
                    </tr>
                  </thead>
                  <tbody>
                    {flattenConfig(cfg.config).map((p) => (
                      <tr key={p.path}>
                        <td className="text-ink-2">{p.path}</td>
                        <td className="num text-ink">
                          {Array.isArray(p.value) ? p.value.join(", ") : String(p.value)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </Panel>
      </div>

      <Panel
        title="跑回测"
        tone="warn"
        hint="A股约束默认全开且不提供开关：关掉任何一条都会让回测虚高"
        right={
          <>
            T+1 · 涨停买不进 · 跌停卖不出 · 停牌不成交 · 滑点{" "}
            {(DEFAULT_CONSTRAINTS.slippage * 100).toFixed(2)}% · 费率{" "}
            {(DEFAULT_CONSTRAINTS.feeRate * 100).toFixed(2)}%
          </>
        }
      >
        {cfg.available ? (
          <LabRunner
            strategies={
              strats.length > 0
                ? strats.map((s) => ({ id: s.id, version: s.version }))
                : [{ id: cfg.config.id, version: cfg.config.version }]
            }
            defaultRange={{ from: cal.from ?? "", to: cal.to ?? "" }}
          />
        ) : (
          <>
            <EmptyState u={cfg} />
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <button
                className="border border-line-2 rounded-sm px-3 py-1 text-ink-3 opacity-40 cursor-not-allowed"
                disabled
                title={cfg.reason}
              >
                开始回测
              </button>
              <span className="text-ink-3 text-[11px]">
                按钮禁用不是界面没做完 —— 拿不到合法策略配置时，能点的按钮只会产出一个假成绩。
              </span>
            </div>
          </>
        )}
        <p className="mt-2 text-ink-3 text-[11px]">
          回测在请求线程里同步跑完，区间长会卡住这一页 —— 先用小区间试，别一上来就跑全历史。
        </p>
      </Panel>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
        <Panel title="净值 / 回撤 / 覆盖率" hint="跑完在上方「跑回测」面板内就地渲染">
          <p className="text-ink-3 text-[12px] leading-6">
            报告首页四项必含：覆盖率、缺口天数、低置信因子（ρ&lt;0.8 标红）、有效区间。
            它们和 Calmar 同等份量地显示在 metrics 之前 —— 覆盖率 60% 的 Calmar 3.0
            和覆盖率 99% 的 Calmar 1.5，后者才是可信的那个。
          </p>
        </Panel>

        <Panel title="参数热力图">
          <EmptyState
            u={unavailable(
              "契约 BacktestReport 里没有参数扫描结果字段",
              "寻优层已有 optimize()/heatmap() 与 Heatmap 类型（lib/backtest/optimizer.ts），但那不是 BacktestReport 的一部分，也没有对应的 API/契约类型。要画热力图需先在契约里定一个 sweep 结果类型，前端不自己发明一个"
            )}
            compact
          />
        </Panel>

        <Panel title="回测可用区间" hint="这些是真实数据，现在就能看">
          <KV label="交易日历区间">
            {cal.from ?? "—"} → {cal.to ?? "—"}
          </KV>
          <KV label="日历内交易日">
            <Num v={cal.openDays} kind="int" />
          </KV>
          <KV label="kline_daily 行数">
            <Num v={count("kline_daily")} kind="int" />
          </KV>
          <KV label="kline_min 行数" hint="不可回补">
            <Num v={count("kline_min")} kind="int" />
          </KV>
          <KV label="zt_pool 行数" hint="情绪因子原料，不可回补">
            <Num v={count("zt_pool")} kind="int" />
          </KV>
          <KV label="sector_rank 行数" hint="主线识别原料">
            <Num v={count("sector_rank")} kind="int" />
          </KV>
          <p className="mt-2 text-ink-3 text-[11px]">
            截面表行数少 = 情绪/主线因子在历史区间无原料，回测只能用代理重建，
            结论天然带误差且必须在报告首页标注（spec §10.3）。
            复权断层（spec R1）还可能把有效区间从 4 年压到 2.6 年。
          </p>
        </Panel>
      </div>

      <p className="text-ink-3 text-[11px]">
        幸存者偏差：回测标的池必须按 listDate/delistDate 过滤当日在市清单，
        用当前在市清单回测 2022 年等于假装当年买的没一只退市（spec §10.2）。
        这条约束在 PointInTimeView.universe() 里，不在前端。
      </p>
    </div>
  );
}
