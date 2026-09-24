import Link from "next/link";
import { EmptyState, NoDatabase } from "@/components/EmptyState";
import { Panel } from "@/components/Panel";
import { StockChart } from "@/components/StockChart";
import { AdviceTable } from "@/components/AdviceTable";
import { CandidateScanButton } from "@/components/CollectScan";
import { CycleStageLight } from "@/components/CycleStage";
import { ShadowSummary } from "@/components/ShadowPanel";
import { CandidateTable, CardWarnings, GearLight } from "@/components/SignalCardView";
import { readDb, dbUnavailable } from "@/lib/ui/db";
import { fmtTs } from "@/lib/ui/format";
import { unavailable } from "@/lib/ui/derive";
import { todaySignalCard } from "@/lib/ui/adapters/engines";
import { readStrategyConfig } from "@/lib/ui/adapters/strategy";
import { cycleStage, pricingRefs, shadowOverview } from "@/lib/ui/adapters/overview";
import { lastTradingDay } from "@/lib/ui/queries";
import { shanghaiParts } from "@/lib/ui/status";
import { shanghaiTs } from "@/lib/ui/time";
import { intradayIntervalMin } from "@/lib/data/schedule";

/**
 * 作战台 —— 系统唯一的主页。早上打开就是它，其余功能都是右侧抽屉（lib/ui/drawers.ts）。
 *
 * 布局按"早上要做的事"的顺序：
 *   1. 顶部一排：今天能不能买（档位）、周期在哪一段（阶段）、影子盘有没有要我批的
 *   2. 左栏：候选池 → 持仓怎么办 → 观察池能不能买；右栏：K 线固定在视野里，点哪只看哪只
 * 盘面原料（涨停池、连板、板块、龙虎榜）挪进「盘面原料」抽屉：它们是原料，不是结论。
 *
 * 本页不做任何决策计算：档位、候选、建议全部来自策略引擎。
 */
export default function CockpitView() {
  const db = readDb();
  if (!db) return <NoDatabase why={dbUnavailable()} />;

  const now = new Date();
  const tradeDay = lastTradingDay(db, shanghaiParts(now).date);
  // 候选池的变化节奏 = 采集轮次，从时刻表推出来
  const scanMin = intradayIntervalMin();
  const cfg = readStrategyConfig();
  // asOf 显式传入：因子层禁用 Date.now，同一次渲染里所有因子必须看到同一个"现在"
  const asOf = shanghaiTs(now);
  const card = cfg.available
    ? todaySignalCard(db, asOf, cfg.config, { advice: true })
    : unavailable(`策略配置不可用：${cfg.reason}`, cfg.needs);
  const stage = cfg.available ? cycleStage(db, asOf, cfg.config) : null;
  const timerInUse = cfg.available && cfg.config.槽位?.择时器?.用 === "五段状态机";
  const pricing = cfg.available && card.available ? pricingRefs(db, asOf, cfg.config, card.card.candidates) : undefined;
  const shadow = shadowOverview(db);

  // K 线默认先看第一只候选，没有候选看第一笔持仓 —— 打开页面图就不是空的
  const first = card.available ? card.card.candidates[0] ?? null : null;
  const firstHold = card.available ? (card.card.advice ?? []).find(a => a.kind === "持仓") ?? null : null;
  const chartCode = first?.code ?? firstHold?.code;
  const chartLevels = first
    ? { trigger: first.triggerPx, stop: first.stopPx, target: pricing?.get(first.code)?.targetPx ?? null }
    : firstHold ? { stop: firstHold.stopPx } : undefined;

  return (
    <div className="flex flex-col gap-3">
      {/* ── 顶部：档位 / 阶段 / 影子盘 ── */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
        <Panel
          title="环境档位"
          hint="进攻 / 中性 / 防守（防守 = 0 仓，不是轻仓）"
          right={
            <span>
              {tradeDay ? `交易日 ${tradeDay}` : "无日历"}
              {cfg.available ? (
                <Link href="/settings" scroll={false} className="ml-2 text-info">
                  {cfg.config.名称 ?? cfg.config.id}@{cfg.config.version}
                </Link>
              ) : null}
            </span>
          }
        >
          {!card.available ? <EmptyState u={card} /> : <GearLight env={card.card.env} />}
        </Panel>

        <Panel title="情绪阶段" hint="冰点 → 启动 → 发酵 → 高潮 → 退潮；名字人定，阈值由数据学">
          {stage === null ? <EmptyState u={cfg as any} compact /> : !stage.available ? <EmptyState u={stage} compact /> : <CycleStageLight s={stage} timerInUse={timerInUse} />}
        </Panel>

        <Panel title="影子盘" hint="赢过正式组合才换上去" right={<Link href="/shadow" scroll={false} className="text-info">详情 →</Link>}>
          {!shadow.available ? <EmptyState u={shadow} compact /> : <ShadowSummary v={shadow} />}
        </Panel>
      </div>

      {/* ── 信号卡警告：有缺口必须上卡，默认折叠只露条数 ── */}
      {card.available ? <CardWarnings card={card.card} collapsible /> : null}

      {/* ── 主区：左栏结论，右栏 K 线 ── */}
      <div className="grid grid-cols-1 2xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-3 items-start">
        <div className="flex flex-col gap-3 min-w-0">
          {/*
            hint 里的节奏取自时刻表（intradayIntervalMin），不是手打的"5 分钟"：
            候选池是渲染时现算的，真正让它变化的是采集轮次。
          */}
          <Panel
            title="候选池"
            hint={`到触发价才动手，不是市价追。采集 ${scanMin} 分钟一轮，两轮之间重算结果相同`}
            right={
              <span className="flex items-start gap-2">
                <span className="pt-0.5">{card.available ? `${card.phase} · asOf ${fmtTs(card.asOf)}` : "不可用"}</span>
                <CandidateScanButton intervalMin={scanMin} />
              </span>
            }
          >
            {!card.available ? <EmptyState u={card} /> : (
              <>
                <div>
                  <CandidateTable
                    rows={card.card.candidates}
                    pricing={pricing}
                    emptyWhat="引擎已跑，今日无买入候选"
                    emptyHint="档位为防守（0 仓）或全部标的被过滤器否决时，这是正常且正确的结果"
                  />
                </div>
                <p className="mt-2 text-[11px] text-ink-3">
                  在市标的 {card.universe.total} 只
                  {card.universe.unknownRatio > 0 ? (
                    <span className="text-warn">，其中 {(card.universe.unknownRatio * 100).toFixed(1)}% 上市日未知、逃过了幸存者过滤（spec §10.2），覆盖面带这个折扣</span>
                  ) : null}
                  {card.card.advisorInfluenced ? <span className="text-warn">；本卡参数被 Advisor 改过</span> : null}
                </p>
              </>
            )}
          </Panel>

          <Panel
            title="持仓动作"
            hint="纪律动作照做（破止损、到止盈档）；技术面倾向与提示只作参考"
            right={<Link href="/positions" scroll={false} className="text-info">持仓管理 →</Link>}
          >
            {!card.available ? <EmptyState u={card} compact /> : (
              <AdviceTable rows={card.card.advice ?? []} kind="持仓" emptyWhat="没有持仓" emptyHint="手工成交回填后才会出现在这里（持仓管理 → 回填成交）" />
            )}
          </Panel>

          <Panel
            title="观察池建议"
            hint="正式评估器逐只判今天能不能买；技术面提示只作参考"
            right={<Link href="/watchpool" scroll={false} className="text-info">管理观察池 →</Link>}
          >
            {!card.available ? <EmptyState u={card} compact /> : (
              <AdviceTable rows={card.card.advice ?? []} kind="观察" emptyWhat="观察池是空的" emptyHint="在观察池抽屉里加入想盯的票，这里每天给出能不能买" />
            )}
          </Panel>
        </div>

        <section id="chart" className="2xl:sticky 2xl:top-2 min-w-0">
          <Panel title="K 线" hint="结构位、M 顶 W 底、日/周线交叉都来自因子层" right="点任意「看图」换票">
            <StockChart initialCode={chartCode} initialLevels={chartLevels} />
          </Panel>
        </section>
      </div>

      <p className="text-ink-3 text-[11px]">
        执行是手工的：本界面只出信号，下单在券商 App 里手敲，回来回填成交。本页不构成投资建议；价格来自免费非官方接口，非交易级。
      </p>
    </div>
  );
}
