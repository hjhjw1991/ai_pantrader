import Link from "next/link";
import { EmptyState, NoDatabase, NoRows } from "@/components/EmptyState";
import { Num } from "@/components/Num";
import { KV, Panel, Tag } from "@/components/Panel";
import { AccountForm, ManualFillForm } from "@/components/forms";
import { dbPath, readDb } from "@/lib/ui/db";
import { fmtAmount, fmtTs } from "@/lib/ui/format";
import { unavailable } from "@/lib/ui/derive";
import { readStrategyConfig } from "@/lib/ui/adapters/strategy";
import { latestQuoteTs, trades } from "@/lib/ui/queries";
import { positionsView, type PositionView } from "@/lib/ui/views";
export const dynamic = "force-dynamic";

/**
 * 持仓管理。spec §13：账户分离、浮盈亏、止损止盈线、硬线告警、组合风控占比。
 *
 * 账户**由用户自己定义**（设置页增删改），这里按 account 表里实际存在的账户渲染，
 * 代码不预设任何账户名。早期版本写死了两个账户，改个名字页面就空一半。
 *
 * 每个账户**物理分开渲染**，不做一张合表：不同账户的离场纪律可以完全不同
 * （按比例止损 vs 逻辑破坏才走），混在一张表里看会把两套纪律搅乱。
 * 每账户的提示语来自它自己的 YAML 规则，不由代码按名字猜。
 */
export default function PositionsPage() {
  const db = readDb();
  if (!db) return <NoDatabase path={dbPath()} />;

  const cfg = readStrategyConfig();
  const pv = positionsView(db, cfg.available ? cfg.config : null);
  const snapTs = latestQuoteTs(db);
  const recent = trades(db, 50);

  return (
    <div className="flex flex-col gap-3">
      {pv.alerts.length > 0 ? (
        <Panel title="硬线告警" tone="danger" right="纪律优先于当下的盘面感觉">
          <ul className="flex flex-col gap-1">
            {pv.alerts.map((a, i) => (
              <li
                key={i}
                className={`px-2 py-1 border rounded-sm ${
                  a.level === "danger"
                    ? "border-danger/60 bg-danger/10"
                    : "border-warn/50 bg-warn/10"
                }`}
              >
                <span className="num text-ink mr-2">{a.code}</span>
                <span className="text-ink-2 mr-2">{a.account}</span>
                <Tag tone={a.level === "danger" ? "danger" : "warn"}>{a.line}</Tag>
                <span className="ml-2 text-ink-2">{a.message}</span>
              </li>
            ))}
          </ul>
        </Panel>
      ) : null}

      {!pv.rulesFromConfig ? (
        <Panel title="止损/止盈规则来源" tone="warn">
          <EmptyState
            u={unavailable(
              "未从 config/strategy.yaml 读到 `持仓.<账户>` 规则段",
              "在此之前只按每只票自己的止损价告警；账户级比例线（止损/灾难位/止盈档）不套任何内置默认值 —— 内置默认会让人误以为是自己设的线"
            )}
            compact
          />
        </Panel>
      ) : null}

      {pv.orphanAccountIds.length > 0 ? (
        <Panel title="账户数据不一致" tone="danger">
          <p className="text-ink-2">
            以下 account_id 在 position 表里出现，但 account 表查不到：
            <span className="num text-danger ml-2">{pv.orphanAccountIds.join(" ")}</span>
          </p>
          <p className="mt-1 text-ink-3 text-[11px]">
            这会导致止损规则套错账户类型。请在下方补建账户。
          </p>
        </Panel>
      ) : null}

      {/* ── 账户分离渲染，账户清单来自 account 表 ── */}
      {pv.accounts.length === 0 ? (
        <NoRows
          what="还没有账户"
          hint="账户由你自己定义（名称、类型、各自的止损规则）。在下方新建一个，持仓与信号才有地方归属。"
        />
      ) : null}

      {pv.accounts.map((a) => {
        const acc = a.id;
        const rows = pv.rows.filter((r) => r.position.account === acc);
        const hasRules = pv.rulesFromConfig && !pv.rulesWithoutAccount.includes(acc);
        return (
          <Panel
            key={acc}
            title={a.name || acc}
            hint={
              hasRules
                ? `规则来自 strategy.yaml 持仓.${acc}`
                : `strategy.yaml 的持仓段没有 ${acc} 的规则，硬线告警对该账户不生效`
            }
            right={`${rows.length} 只 · 快照 ${fmtTs(snapTs, true)}`}
          >
            {rows.length === 0 ? (
              <NoRows
                what={`${a.name || acc} 无持仓`}
                hint="手工成交回填后出现在这里；position 表不由行情 job 写"
              />
            ) : (
              <PositionTable rows={rows} />
            )}
          </Panel>
        );
      })}

      {/* ── 组合风控占比 ── */}
      <Panel
        title="组合风控占比"
        hint="spec §9.1 组合风控：总仓位上限 / 单票最大占比 / 单行业最大占比 / 核心卫星比例"
      >
        <div className="grid grid-cols-1 md:grid-cols-2 gap-x-6">
          <div>
            <KV label="持仓市值合计" hint={pv.risk.missingQuoteCodes.length ? "有票无报价，合计不可信" : undefined}>
              <Num v={pv.risk.totalMarketValue} kind="amount" />
            </KV>
            {pv.risk.byAccount.map((a) => (
              <KV key={a.account} label={`${a.account}账户市值`} hint={`${a.positions} 只`}>
                <Num v={a.marketValue} kind="amount" />
              </KV>
            ))}
            <KV label="单票最大市值" hint={pv.risk.maxSingleCode ?? undefined}>
              <Num v={pv.risk.maxSingleRatio} kind="ratio" />
            </KV>
          </div>
          <div className="text-[12px]">
            <p className="text-warn">占比类指标为何是破折号：</p>
            <ul className="mt-1 list-disc pl-4 text-ink-3 leading-6">
              <li>
                <span className="text-ink-2">总仓位占比 / 单票占比</span>：分母是账户总资产，
                库里没有这个字段（account 表只有 id/name/type，没有现金与总权益）。
                用持仓市值当分母会恒等于 100%，那是个假指标。
              </li>
              <li>
                <span className="text-ink-2">单行业最大占比</span>：库里没有行业分类。
                security.board 是上市板（主板/创业板/科创板/北交所）不是行业；
                zt_pool.sector 只覆盖当日涨停票。不拿上市板冒充行业。
              </li>
              <li>
                <span className="text-ink-2">核心卫星比例</span>：持仓表没有核心/卫星标记字段。
              </li>
            </ul>
            {pv.risk.missingQuoteCodes.length > 0 ? (
              <p className="mt-2 text-danger">
                无快照的持仓：
                <span className="num ml-1">{pv.risk.missingQuoteCodes.join(" ")}</span>
                （停牌或采集缺失，市值与浮盈亏都算不出来）
              </p>
            ) : null}
          </div>
        </div>
      </Panel>

      {/* ── 手工回填 ── */}
      <Panel
        title="回填成交"
        hint="manual 模式：你在券商 App 手敲下单，回来把成交登记进来"
        right="系统不下单"
      >
        <ManualFillForm accountIds={pv.accounts.map((a) => a.id)} />
        <p className="mt-2 text-ink-3 text-[11px]">
          这不是下单按钮。自动下单要等券商权限到位 + paper 模式连续跑满一个季度并达标
          （spec §18.2 红线），在那之前系统里不存在下单能力。
        </p>
      </Panel>

      <Panel title="账户" hint="类型决定套哪套止损规则，不可混用">
        {pv.accounts.length === 0 ? (
          <NoRows what="account 表为空" hint="先建账户才能回填成交" />
        ) : (
          <div className="overflow-x-auto mb-3">
            <table className="dense">
              <thead>
                <tr>
                  <th>id</th>
                  <th>名称</th>
                  <th>类型</th>
                </tr>
              </thead>
              <tbody>
                {pv.accounts.map((a) => (
                  <tr key={a.id}>
                    <td className="num text-ink">{a.id}</td>
                    <td>{a.name}</td>
                    <td className="text-ink-2">{a.type}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <AccountForm />
      </Panel>

      <Panel title="近期成交" right={`${recent.length} 条`}>
        {recent.length === 0 ? (
          <NoRows what="trade 表无记录" />
        ) : (
          <div className="overflow-x-auto max-h-80 overflow-y-auto">
            <table className="dense">
              <thead>
                <tr>
                  <th className="text-right">时间</th>
                  <th>账户</th>
                  <th>代码</th>
                  <th>方向</th>
                  <th className="text-right">成交价</th>
                  <th className="text-right">数量</th>
                  <th className="text-right">费用</th>
                  <th>来源</th>
                  <th>关联预测</th>
                </tr>
              </thead>
              <tbody>
                {recent.map((t) => (
                  <tr key={t.id}>
                    <td className="num text-ink-2">{fmtTs(t.ts, true)}</td>
                    <td className="num text-ink-2">{t.accountId}</td>
                    <td className="num text-ink">{t.code}</td>
                    <td className={t.side === "buy" ? "text-up" : "text-down"}>
                      {t.side === "buy" ? "买入" : "卖出"}
                    </td>
                    <td className="num">
                      <Num v={t.px} />
                    </td>
                    <td className="num">
                      <Num v={t.qty} kind="qty" />
                    </td>
                    <td className="num">{fmtAmount(t.fee)}</td>
                    <td className="text-ink-2">{t.source}</td>
                    <td className="num text-ink-3">{t.predictionId ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="mt-2 text-ink-3 text-[11px]">
          成交与预测的关联是台账归因的原料，
          <Link href="/ledger" className="text-info ml-1">
            台账/胜率 →
          </Link>
        </p>
      </Panel>
    </div>
  );
}

function PositionTable({ rows }: { rows: PositionView[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="dense">
        <thead>
          <tr>
            <th>代码</th>
            <th>名称</th>
            <th className="text-right">数量</th>
            <th className="text-right">成本</th>
            <th className="text-right">现价</th>
            <th className="text-right">市值</th>
            <th className="text-right">浮动盈亏</th>
            <th className="text-right">浮动%</th>
            <th className="text-right">止损价</th>
            <th className="text-right">距止损</th>
            <th className="text-right">建仓日</th>
            <th>逻辑</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={`${r.position.accountId}-${r.position.code}`}>
              <td className="num text-ink">{r.position.code}</td>
              <td>{r.name ?? "—"}</td>
              <td className="num">
                <Num v={r.position.qty} kind="qty" />
              </td>
              <td className="num">
                <Num v={r.position.cost} />
              </td>
              <td className="num">
                <Num v={r.quote?.price ?? null} />
              </td>
              <td className="num">
                <Num v={r.pnl.marketValue} kind="amount" />
              </td>
              <td className="num">
                <Num v={r.pnl.pnl} kind="amount" dir />
              </td>
              <td className="num">
                <Num v={r.pnl.pnlRatio} kind="ratio" dir />
              </td>
              <td className="num">
                <Num v={r.position.stopPx} />
              </td>
              <td className="num">
                <Num v={r.stopGapRatio} kind="ratio" dir />
              </td>
              <td className="num text-ink-3">{r.position.openDate}</td>
              <td className="text-ink-3 max-w-[20rem] truncate" title={r.position.thesis}>
                {r.position.thesis || "—"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
