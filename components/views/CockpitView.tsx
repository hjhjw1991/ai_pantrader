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
import { latestZtDate, ztPool } from "@/lib/ui/queries";
import { shanghaiTs } from "@/lib/ui/time";

/**
 * 作战台 —— 系统唯一的主页：
 *   顶部一排：盘面环境 —— 今天能不能买（档位）、周期在哪一段（阶段）、盘面温度、影子盘，明细点开看
 *   主体：左边自选列表（今日候选 / 持仓 / 观察池），右边选中那只的决策卡或几只的对比表，下面 K 线
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

const STAGE_TONE: Record<string, string> = { 冰点: "text-info", 启动: "text-up", 发酵: "text-up", 高潮: "text-warn", 退潮: "text-down" };

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

  const env = card.available ? card.card.env : null;
  const warns = card.available ? card.card.warnings : [];

  return (
    <div className="flex flex-col gap-3">
      {/* ── 顶部：盘面环境，一排紧凑卡片；明细点开看 ── */}
      <div className="grid grid-cols-1 md:grid-cols-2 2xl:grid-cols-4 gap-3 items-start">
        <Card title="环境档位" right={
          cfg.available ? <Link href="/settings" scroll={false} className="text-info">{cfg.config.名称 ?? cfg.config.id}@{cfg.config.version}</Link> : null
        }>
          {env === null ? <EmptyState u={card as any} compact /> : (
            <div className="flex flex-col gap-1.5">
              <div className="flex items-baseline gap-3">
                <span className={`text-2xl font-semibold ${gearClass(env.gear)}`}>{env.gear}</span>
                <span className="text-ink-2">目标仓位 <span className="num text-ink">{(env.targetPosition * 100).toFixed(0)}%</span></span>
                {env.gear === "防守" ? <span className="text-down text-[11px]">0 仓，不是轻仓</span> : null}
              </div>
              <p className="text-[12px] text-ink-2 truncate" title={env.reasons.join("；")}>{env.reasons[0] ?? "—"}</p>
              <details>
                <summary className="cursor-pointer text-[11px] text-ink-3">
                  归因 {env.reasons.length} 条 · 因子 {env.factors.length} 个
                  {env.lowConfidenceFactors.length > 0 ? <span className="text-warn"> · 低置信 {env.lowConfidenceFactors.length}</span> : null}
                </summary>
                <ul className="mt-1 text-[12px] text-ink-2 leading-5 list-disc pl-4">{env.reasons.map((r, k) => <li key={k}>{r}</li>)}</ul>
                {env.lowConfidenceFactors.length > 0 ? <p className="mt-1 text-[11px] text-warn">低置信：{env.lowConfidenceFactors.join(" ")}（情绪类因子由日线代理重建）</p> : null}
                <FactorTable factors={env.factors} />
              </details>
            </div>
          )}
        </Card>

        <Card title="情绪阶段" right={stage && stage.available ? `按 ${stage.date} 收盘` : null}>
          {stage === null ? <EmptyState u={cfg as any} compact /> : !stage.available ? <EmptyState u={stage} compact /> : (
            <div className="flex flex-col gap-1.5">
              <div className="flex items-baseline gap-3">
                <span className={`text-2xl font-semibold ${STAGE_TONE[stage.stage ?? ""] ?? "text-ink-3"}`}>{stage.stage ?? stage.label}</span>
                {stage.stage ? <span className="text-ink-2">已持续 <span className="num text-ink">{stage.days ?? "—"}</span> 天 · 热度 <span className="num text-ink">{stage.heat?.toFixed(2) ?? "—"}</span></span> : null}
              </div>
              <div className="flex gap-1">
                {["冰点", "启动", "发酵", "高潮", "退潮"].map(k => (
                  <span key={k} className={`flex-1 text-center text-[11px] rounded-sm border py-0.5 ${k === stage.stage ? `border-current ${STAGE_TONE[k]} bg-panel-2` : "border-line text-ink-3"}`}>{k}</span>
                ))}
              </div>
              <details>
                <summary className="cursor-pointer text-[11px] text-ink-3">近 10 日轨迹与七项分位{timerInUse ? "" : " · 正式策略目前不按阶段定档"}</summary>
                <div className="mt-1"><CycleStageLight s={stage} timerInUse={timerInUse} /></div>
              </details>
            </div>
          )}
        </Card>

        <Card title="盘面温度" right={<Link href="/market" scroll={false} className="text-info">{ztDate ?? "无数据"} →</Link>}>
          <div className="grid grid-cols-4 gap-1.5">
            <Tile label="涨停" value={zt.count} tone="text-up" />
            <Tile label="最高板" value={zt.maxLbc} tone="text-up" />
            <Tile label="连板" value={zt.ladder.length} />
            <Tile label="炸板" value={zt.openTimesTotal} tone="text-down" />
          </div>
          {warns.length > 0 ? (
            <details className="mt-2">
              <summary className="cursor-pointer text-[11px] text-warn">
                信号卡警告 {warns.length} 条{warns.some(w => w.includes("缺口")) ? <span className="text-danger"> · 含数据缺口</span> : null}
              </summary>
              <ul className="mt-1 list-disc pl-4 text-[11px] text-ink-2 leading-5">{warns.map((w, k) => <li key={k}>{w}</li>)}</ul>
            </details>
          ) : null}
        </Card>

        <Card title="影子盘" right={<Link href="/shadow" scroll={false} className="text-info">详情 →</Link>}>
          {!shadow.available ? <EmptyState u={shadow} compact /> : <ShadowSummary v={shadow} />}
        </Card>
      </div>

      {/* ── 主体：自选列表 | 决策卡 / 对比 + K 线 ── */}
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
  );
}
