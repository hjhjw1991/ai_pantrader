import Link from "next/link";
import type { ReactNode } from "react";
import { EmptyState, NoDatabase } from "@/components/EmptyState";
import { CycleStageLight } from "@/components/CycleStage";
import { ShadowSummary } from "@/components/ShadowPanel";
import { FactorTable } from "@/components/SignalCardView";
import { DecisionBoard } from "@/components/cockpit/DecisionBoard";
import { readDb, dbUnavailable } from "@/lib/ui/db";
import { fmtTs, gearClass } from "@/lib/ui/format";
import { unavailable, ztStats } from "@/lib/ui/derive";
import { todaySignalCard } from "@/lib/ui/adapters/engines";
import { readStrategyConfig } from "@/lib/ui/adapters/strategy";
import { cycleStage, pricingRefs, shadowOverview } from "@/lib/ui/adapters/overview";
import { cockpitItems } from "@/lib/ui/adapters/cockpit";
import { lastTradingDay, latestZtDate, ztPool } from "@/lib/ui/queries";
import { shanghaiParts } from "@/lib/ui/status";
import { shanghaiTs } from "@/lib/ui/time";

/**
 * 作战台 —— 系统唯一的主页，三栏：
 *   左：盘面环境 —— 今天能不能买（档位）、周期在哪一段（阶段）、盘面温度、影子盘
 *   中：选中那只票的决策卡（动作、价位、理由）+ K 线
 *   右：自选列表 —— 今日候选 / 持仓 / 观察池，点哪只看哪只
 * 其余功能都是右侧抽屉（lib/ui/drawers.ts），从左侧导航打开。
 *
 * 本页不做任何决策计算：档位、候选、建议全部来自策略引擎。
 */

function Card({ title, right, children }: { title: string; right?: ReactNode; children: ReactNode }) {
  return (
    <section className="bg-panel border border-line rounded-sm">
      <header className="flex items-baseline gap-2 px-3 py-2 border-b border-line">
        <h2 className="text-ink font-medium">{title}</h2>
        <div className="ml-auto text-[11px] text-ink-3">{right}</div>
      </header>
      <div className="p-3">{children}</div>
    </section>
  );
}

function Tile({ label, value, tone }: { label: string; value: ReactNode; tone?: string }) {
  return (
    <div className="bg-panel-2 rounded-sm px-2 py-1.5 text-center">
      <div className="text-[10px] text-ink-3">{label}</div>
      <div className={`num text-base ${tone ?? "text-ink"}`}>{value}</div>
    </div>
  );
}

export default function CockpitView() {
  const db = readDb();
  if (!db) return <NoDatabase why={dbUnavailable()} />;

  const now = new Date();
  const tradeDay = lastTradingDay(db, shanghaiParts(now).date);
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
  const items = card.available ? cockpitItems(db, card.card, pricing) : [];
  const ztDate = latestZtDate(db);
  const zt = ztStats(ztDate ? ztPool(db, ztDate) : []);

  return (
    <div className="grid grid-cols-1 lg:grid-cols-[300px_minmax(0,1fr)] gap-3 items-start">
      {/* ── 左栏：盘面环境 ── */}
      <div className="flex flex-col gap-3 min-w-0">
        <Card title="环境档位" right={
          cfg.available ? <Link href="/settings" scroll={false} className="text-info">{cfg.config.名称 ?? cfg.config.id}@{cfg.config.version}</Link> : null
        }>
          {!card.available ? <EmptyState u={card} compact /> : (() => {
            const env = card.card.env;
            return (
              <div className="flex flex-col gap-2">
                <div className="flex items-baseline gap-3">
                  <span className={`text-3xl font-semibold ${gearClass(env.gear)}`}>{env.gear}</span>
                  <span className="text-ink-2">目标仓位 <span className="num text-ink">{(env.targetPosition * 100).toFixed(0)}%</span></span>
                </div>
                {env.gear === "防守" ? <span className="text-down text-[12px]">防守 = 0 仓，不是轻仓</span> : null}
                <ul className="text-[12px] text-ink-2 leading-5 list-disc pl-4">
                  {env.reasons.map((r, i) => <li key={i}>{r}</li>)}
                </ul>
                {env.lowConfidenceFactors.length > 0 ? (
                  <p className="text-[11px] text-warn" title="情绪类因子由日线代理重建，不是真值">
                    低置信因子参与了判断：{env.lowConfidenceFactors.join(" ")}
                  </p>
                ) : null}
                <details>
                  <summary className="cursor-pointer text-[11px] text-ink-3">因子读数（{env.factors.length}）· 交易日 {tradeDay ?? "—"}</summary>
                  <FactorTable factors={env.factors} />
                </details>
              </div>
            );
          })()}
        </Card>

        <Card title="情绪阶段" right="阈值由数据学">
          {stage === null ? <EmptyState u={cfg as any} compact /> : !stage.available ? <EmptyState u={stage} compact /> : <CycleStageLight s={stage} timerInUse={timerInUse} />}
        </Card>

        <Card title="盘面温度" right={<Link href="/market" scroll={false} className="text-info">{ztDate ?? "无数据"} →</Link>}>
          <div className="grid grid-cols-2 gap-1.5">
            <Tile label="涨停家数" value={zt.count} tone="text-up" />
            <Tile label="最高连板" value={zt.maxLbc} tone="text-up" />
            <Tile label="连板家数" value={zt.ladder.length} />
            <Tile label="炸板次数" value={zt.openTimesTotal} tone="text-down" />
          </div>
        </Card>

        <Card title="影子盘" right={<Link href="/shadow" scroll={false} className="text-info">详情 →</Link>}>
          {!shadow.available ? <EmptyState u={shadow} compact /> : <ShadowSummary v={shadow} />}
        </Card>

        {card.available && card.card.warnings.length > 0 ? (
          <details className="bg-panel border border-warn/50 rounded-sm px-3 py-2">
            <summary className="cursor-pointer text-warn">
              信号卡警告 {card.card.warnings.length} 条
              {card.card.warnings.some(w => w.includes("缺口")) ? <span className="ml-1 text-danger">含数据缺口</span> : null}
            </summary>
            <ul className="mt-1 list-disc pl-4 text-[11px] text-ink-2 leading-5">
              {card.card.warnings.map((w, i) => <li key={i}>{w}</li>)}
            </ul>
          </details>
        ) : null}
      </div>

      {/* ── 中栏 + 右栏：决策卡 / K 线 / 自选 ── */}
      <div className="min-w-0 flex flex-col gap-2">
        {!card.available ? <EmptyState u={card} /> : (
          <DecisionBoard
            items={items}
            emptyNote={`引擎已跑（${card.card.phase} · ${fmtTs(card.asOf)}），今天没有候选、持仓或观察中的票。档位为防守或全部被过滤器否决时这是正常结果。`}
          />
        )}
        <p className="text-ink-3 text-[11px]">
          执行是手工的：本界面只出信号，下单在券商 App 里手敲，回来回填成交。本页不构成投资建议；价格来自免费非官方接口，非交易级。
          {card.available ? ` 信号 asOf ${fmtTs(card.asOf)}。` : ""}
        </p>
      </div>
    </div>
  );
}
