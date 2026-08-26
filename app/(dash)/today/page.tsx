import Link from "next/link";
import { EmptyState, NoDatabase, NoRows } from "@/components/EmptyState";
import { Num } from "@/components/Num";
import { KV, Panel, Tag } from "@/components/Panel";
import { DailyChart } from "@/components/DailyChart";
import { CandidateScanButton } from "@/components/CollectScan";
import { readDb, dbUnavailable } from "@/lib/ui/db";
import { fmtAmount, fmtPct, fmtTs, dirClass } from "@/lib/ui/format";
import { ztStats, unavailable } from "@/lib/ui/derive";
import { todaySignalCard } from "@/lib/ui/adapters/engines";
import { readStrategyConfig } from "@/lib/ui/adapters/strategy";
import {
  CandidateTable,
  CardMeta,
  CardWarnings,
  GearLight,
} from "@/components/SignalCardView";
import {
  lastTradingDay,
  latestLhbDate,
  latestZtDate,
  lhbRows,
  sectorRank,
  ztPool,
} from "@/lib/ui/queries";
import { positionsView } from "@/lib/ui/views";
import { shanghaiParts } from "@/lib/ui/status";
import { shanghaiTs } from "@/lib/ui/time";
import { intradayIntervalMin } from "@/lib/data/schedule";

export const dynamic = "force-dynamic";

/**
 * 今日作战台。spec §13 四块：环境档位灯 / 候选池 / 持仓动作 / 龙头温度计。
 *
 * 前三块来自策略引擎（lib/strategy + lib/factors），本页不做任何决策计算。
 * 第四块标着"涨停池原始聚合"而不是温度计因子：它只是把 zt_pool 里的真值分组数了一遍，
 * 没有代理重建也没有 confidence，措辞不能混。
 */
export default function TodayPage() {
  const db = readDb();
  if (!db) return <NoDatabase why={dbUnavailable()} />;

  const now = new Date();
  const today = shanghaiParts(now).date;
  const tradeDay = lastTradingDay(db, today);
  // 候选池的变化节奏 = 采集轮次，从时刻表推出来
  const scanMin = intradayIntervalMin();
  const cfg = readStrategyConfig();
  // asOf 显式传入：因子层禁用 Date.now，同一次渲染里所有因子必须看到同一个"现在"
  const card = cfg.available
    ? todaySignalCard(db, shanghaiTs(now), cfg.config)
    : unavailable(`策略配置不可用：${cfg.reason}`, cfg.needs);

  const ztDate = latestZtDate(db);
  const zt = ztDate ? ztPool(db, ztDate) : [];
  const stats = ztStats(zt);
  const sectors = tradeDay ? sectorRank(db, tradeDay) : [];

  const lhbDate = latestLhbDate(db);
  const lhb = lhbDate ? lhbRows(db, lhbDate) : [];

  const pv = positionsView(db, cfg.available ? cfg.config : null);

  return (
    <div className="flex flex-col gap-3">
      {/* ── 环境档位灯 ── */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
        <Panel
          title="环境档位灯"
          hint="择时：进攻 0.7 / 中性 0.4 / 防守 0（防守 = 0 仓，不是轻仓）"
          right={tradeDay ? `交易日 ${tradeDay}` : "无日历"}
        >
          {!card.available ? <EmptyState u={card} /> : <GearLight env={card.card.env} />}
        </Panel>

        <Panel
          title="策略配置"
          hint="YAML 是唯一真相源（D7），面板只是它的投影"
          right={<Link href="/settings" className="text-info">参数面板 →</Link>}
        >
          {cfg.available ? (
            <>
              <KV label="策略 id">{cfg.config.id ?? "—"}</KV>
              <KV label="版本">{cfg.config.version ?? "—"}</KV>
              <KV label="总仓位上限">
                <Num v={cfg.config.组合风控?.总仓位上限} kind="ratio" />
              </KV>
              <KV label="单票最大占比">
                <Num v={cfg.config.组合风控?.单票最大占比} kind="ratio" />
              </KV>
              <KV label="必查链" hint="写死不可关闭：板块榜均值会掩盖链内龙头封板">
                <span className="text-ink-2">
                  {(cfg.config.选股?.主线识别?.必查链 ?? []).join(" ") || "—"}
                </span>
              </KV>
              <p className="mt-2 text-[11px] text-ink-3">
                已通过 loader 完整校验（含取值区间）。改参直接编辑 config/strategy.yaml。
              </p>
            </>
          ) : (
            <EmptyState u={cfg} compact />
          )}
        </Panel>

        <Panel title="今日纪律" hint="不打板不超短，目标是长期稳定盈利">
          <ul className="text-ink-2 text-[12px] leading-6 list-disc pl-4">
            <li>只做回踩企稳低吸，不追封板。</li>
            <li>买入前先写得出一句话逻辑，写不出来就不买。</li>
            <li>破止损价按纪律走，不看盘中反弹找理由扛。</li>
            <li>
              执行是手工的：本界面只出信号卡，下单在券商 App 里手敲，回来回填成交。
            </li>
          </ul>
        </Panel>
      </div>

      {/* ── 信号卡警告：有缺口必须上卡 ── */}
      {card.available ? <CardWarnings card={card.card} /> : null}

      {/* ── 候选池 ── */}
      {/*
        hint 里的节奏取自时刻表（intradayIntervalMin），不是手打的"5 分钟"：
        候选池是渲染时现算的，真正让它变化的是采集轮次 ——
        时刻表改成 1 分钟一轮，这句话必须跟着变，否则界面在说一个不成立的节奏。
      */}
      <Panel
        title="候选池"
        hint={
          `策略引擎的当日买入候选，每次打开/刷新页面现算。到触发价才动手，不是市价追。`
          + `最快 ${scanMin} 分钟变一次 —— 采集${scanMin}分钟一轮，两轮之间行情没变，重算结果相同`
        }
        right={
          <span className="flex items-start gap-2">
            <span className="pt-0.5">
              {card.available ? `${card.phase} · asOf ${fmtTs(card.asOf)}` : "不可用"}
            </span>
            <CandidateScanButton intervalMin={scanMin} />
          </span>
        }
      >
        {!card.available ? (
          <EmptyState u={card} />
        ) : (
          <>
            <CardMeta card={card.card} universe={card.universe} />
            <div className="mt-2">
              <CandidateTable
                rows={card.card.candidates}
                emptyWhat="引擎已跑，今日无买入候选"
                emptyHint="档位为防守（0 仓）或全部标的被过滤器否决时，这是正常且正确的结果"
              />
            </div>
            {card.universe.unknownRatio > 0 ? (
              <p className="mt-2 text-warn text-[11px]">
                在市标的池里有 {(card.universe.unknownRatio * 100).toFixed(1)}%
                的票上市日未知，逃过了幸存者过滤（spec §10.2）。候选池的覆盖面带这个折扣。
              </p>
            ) : null}
          </>
        )}
      </Panel>

      {/* ── 持仓动作 ── */}
      <Panel
        title="持仓动作"
        hint="持仓与新开仓分开，早上照着做不用再想"
        right={<Link href="/positions" className="text-info">持仓管理 →</Link>}
      >
        {!card.available ? (
          <EmptyState u={card} compact />
        ) : (
          <CandidateTable
            rows={card.card.holdings}
            emptyWhat="引擎对现有持仓无动作建议"
            emptyHint="没有持仓、或全部持仓都判为「持有」时是正常结果"
          />
        )}

        <div className="mt-3">
          <div className="text-ink-2 mb-1">持仓现状（来自 position 表与最新快照）</div>
          {pv.rows.length === 0 ? (
            <NoRows
              what="position 表无持仓记录"
              hint="手工成交回填后才会出现在这里（持仓管理页 → 回填成交）"
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="dense">
                <thead>
                  <tr>
                    <th>账户</th>
                    <th>代码</th>
                    <th>名称</th>
                    <th className="text-right">成本</th>
                    <th className="text-right">现价</th>
                    <th className="text-right">浮动</th>
                    <th className="text-right">止损价</th>
                    <th className="text-right">距止损</th>
                    <th>逻辑</th>
                  </tr>
                </thead>
                <tbody>
                  {pv.rows.map((r) => (
                    <tr key={`${r.position.accountId}-${r.position.code}`}>
                      <td className="text-ink-2">{r.position.account}</td>
                      <td className="num text-ink">{r.position.code}</td>
                      <td>{r.name ?? "—"}</td>
                      <td className="num"><Num v={r.position.cost} /></td>
                      <td className="num"><Num v={r.quote?.price ?? null} /></td>
                      <td className="num"><Num v={r.pnl.pnlRatio} kind="ratio" dir /></td>
                      <td className="num"><Num v={r.position.stopPx} /></td>
                      <td className="num"><Num v={r.stopGapRatio} kind="ratio" dir /></td>
                      <td className="text-ink-3 max-w-[20rem] truncate">
                        {r.position.thesis || "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {pv.alerts.length > 0 ? (
          <ul className="mt-3 flex flex-col gap-1">
            {pv.alerts.map((a, i) => (
              <li
                key={i}
                className={`px-2 py-1 border rounded-sm ${
                  a.level === "danger"
                    ? "border-danger/60 bg-danger/10 text-danger"
                    : "border-warn/50 bg-warn/10 text-warn"
                }`}
              >
                <span className="num mr-2">{a.code}</span>
                <Tag tone={a.level === "danger" ? "danger" : "warn"}>{a.line}</Tag>
                <span className="ml-2 text-ink-2">{a.message}</span>
              </li>
            ))}
          </ul>
        ) : null}
      </Panel>

      {/* ── 龙头温度计（原料层） ── */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
        <Panel
          title="涨停池原始聚合"
          hint="温度计因子本身在上面的因子表里（带 proxy 标记与 confidence）；这里是它的原料，纯分组计数，无建模"
          right={ztDate ? `涨停池 ${ztDate}` : "无数据"}
        >
          {zt.length === 0 ? (
            <div>
              <NoRows
                what="zt_pool 无数据"
                hint="涨停池不可回补：缺一天永久缺一天，检查采集调度"
              />
            </div>
          ) : (
            <div>
              <KV label="涨停家数">
                <Num v={stats.count} kind="int" />
              </KV>
              <KV label="最高连板">
                <Num v={stats.maxLbc} kind="int" />
              </KV>
              <KV label="连板家数（≥2板）">
                <Num v={stats.ladder.length} kind="int" />
              </KV>
              <KV label="炸板次数合计" hint="情绪转弱最直接的原始信号">
                <Num v={stats.openTimesTotal} kind="int" />
              </KV>
              <KV label="封单额中位数">
                <Num v={stats.sealAmtMedian} kind="amount" />
              </KV>
              <div className="mt-2 flex flex-wrap gap-1">
                {stats.byLbc.map((b) => (
                  <span key={b.lbc} className="border border-line-2 rounded px-1 text-[11px]">
                    {b.lbc}板 <span className="num text-ink">{b.n}</span>
                  </span>
                ))}
              </div>
            </div>
          )}
        </Panel>

        <Panel title="连板梯队" right={ztDate ?? "—"}>
          {stats.ladder.length === 0 ? (
            <NoRows what="无 2 板及以上标的" />
          ) : (
            <div className="overflow-x-auto max-h-72 overflow-y-auto">
              <table className="dense">
                <thead>
                  <tr>
                    <th className="text-right">连板</th>
                    <th>代码</th>
                    <th>名称</th>
                    <th>板块</th>
                    <th className="text-right">封单</th>
                    <th className="text-right">炸板</th>
                  </tr>
                </thead>
                <tbody>
                  {stats.ladder.slice(0, 40).map((r) => (
                    <tr key={r.code}>
                      <td className="num text-up">{r.lbc}</td>
                      <td className="num">{r.code}</td>
                      <td>{(r as { name?: string | null }).name ?? "—"}</td>
                      <td className="text-ink-2">{r.sector ?? "—"}</td>
                      <td className="num">{fmtAmount(r.sealAmt)}</td>
                      <td className="num text-ink-2">{r.openTimes}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>

        <Panel
          title="板块分布 / 涨幅榜"
          hint="必查链（半导体全链/军工/电网/资源）漏扫是主线级误判的根因"
        >
          {sectors.length === 0 ? (
            <>
              <NoRows
                what="sector_rank 无数据"
                hint="板块涨幅榜未采集；下面退化为涨停池的板块计数"
              />
              <div className="mt-2 flex flex-wrap gap-1">
                {stats.bySector.slice(0, 24).map((s) => (
                  <span key={s.sector} className="border border-line-2 rounded px-1 text-[11px]">
                    {s.sector} <span className="num text-up">{s.n}</span>
                  </span>
                ))}
                {stats.bySector.length === 0 ? (
                  <span className="text-ink-3">涨停池也没有板块字段</span>
                ) : null}
              </div>
            </>
          ) : (
            <div className="overflow-x-auto max-h-72 overflow-y-auto">
              <table className="dense">
                <thead>
                  <tr>
                    <th>板块</th>
                    <th className="text-right">涨幅</th>
                    <th>龙头</th>
                  </tr>
                </thead>
                <tbody>
                  {sectors.slice(0, 30).map((s) => (
                    <tr key={s.sector}>
                      <td>{s.sector}</td>
                      <td className={`num ${dirClass(s.pct)}`}>{fmtPct(s.pct)}</td>
                      <td className="num text-ink-2">{s.leaderCode ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>
      </div>

      {/* ── 龙虎榜（真实数据，资金面参考） ── */}
      <Panel
        title="龙虎榜净买入"
        hint="一行 = 一只票的一个上榜原因，同票同日可有多行，别按代码去重"
        right={lhbDate ? `${lhbDate} · ${lhb.length} 行` : "无数据"}
      >
        {lhb.length === 0 ? (
          <NoRows what="lhb 无数据" hint="龙虎榜可按历史日期回补，检查 night job" />
        ) : (
          <div className="overflow-x-auto max-h-96 overflow-y-auto">
            <table className="dense">
              <thead>
                <tr>
                  <th>代码</th>
                  <th>名称</th>
                  <th className="text-right">净买额</th>
                  <th className="text-right">涨跌幅</th>
                  <th className="text-right">换手</th>
                  <th className="text-right">占成交比</th>
                  <th>上榜原因</th>
                  <th className="text-right">D1</th>
                  <th className="text-right">D5</th>
                </tr>
              </thead>
              <tbody>
                {lhb.slice(0, 60).map((r) => (
                  <tr key={`${r.code}-${r.changeType}`}>
                    <td className="num text-ink">{r.code}</td>
                    <td>{r.name || "—"}</td>
                    <td className={`num ${dirClass(r.netAmt)}`}>{fmtAmount(r.netAmt)}</td>
                    <td className="num"><Num v={r.changeRate} kind="pct" dir /></td>
                    <td className="num"><Num v={r.turnoverRate} kind="pct" /></td>
                    <td className="num"><Num v={r.dealAmountRatio} kind="pct" /></td>
                    <td className="text-ink-3 max-w-[22rem] truncate" title={r.explanation}>
                      {r.explanation || "—"}
                    </td>
                    {/* 上榜当日 D1/D5 必然为 null，显示破折号而不是 0 */}
                    <td className="num"><Num v={r.d1Chg} kind="pct" dir /></td>
                    <td className="num"><Num v={r.d5Chg} kind="pct" dir /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      {/* ── 个股日线 ── */}
      <Panel
        title="个股日线"
        hint="kline_daily 真实数据。看回踩位与均线，不做任何信号推断"
        right="输入 6 位代码"
      >
        <DailyChart />
      </Panel>

      <p className="text-ink-3 text-[11px]">
        快照时点见顶栏。本页不构成投资建议；所有价格来自免费非官方接口，非交易级。
      </p>
    </div>
  );
}
