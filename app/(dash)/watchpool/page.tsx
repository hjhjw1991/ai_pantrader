import { NoDatabase, NoRows } from "@/components/EmptyState";
import { Num } from "@/components/Num";
import { Panel, Tag } from "@/components/Panel";
import { WatchpoolForm, WatchpoolRemoveButton } from "@/components/forms";
import { dbPath, readDb } from "@/lib/ui/db";
import { fmtAge, fmtTs, ageMinutes } from "@/lib/ui/format";
import { latestQuoteTs, accounts } from "@/lib/ui/queries";
import { watchpoolView } from "@/lib/ui/views";

export const dynamic = "force-dynamic";

/**
 * 观察池。spec §13：每只标的的买入条件 / 触发价 / 止损 + 实时距离。
 *
 * "实时"要打引号：距离是按 quote_snapshot 的最新快照算的，不是 tick。
 * 所以每一行都带快照时点，页面顶部再强调一次 ——
 * 用几分钟前的价判断"到没到买点"，和用实时价判断，结论可以完全相反。
 */
export default function WatchpoolPage() {
  const db = readDb();
  if (!db) return <NoDatabase path={dbPath()} />;

  const rows = watchpoolView(db);
  const snapTs = latestQuoteTs(db);
  const snapAge = ageMinutes(snapTs);
  const reached = rows.filter((r) => r.dist.reached);

  return (
    <div className="flex flex-col gap-3">
      <Panel
        title="观察池"
        hint="只做回踩企稳低吸：价格跌到触发价及以下才算到位，不追突破"
        right={
          <>
            快照 <span className="num text-ink">{fmtTs(snapTs, true)}</span>（
            {fmtAge(snapAge)}）
          </>
        }
      >
        {rows.length === 0 ? (
          <NoRows
            what="watchpool 表无在册标的"
            hint="用下面的表单加入。这是人工录入的清单，不由策略生成"
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="dense">
              <thead>
                <tr>
                  <th>代码</th>
                  <th>名称</th>
                  <th>账户</th>
                  <th className="text-right">现价</th>
                  <th className="text-right">触发价</th>
                  <th className="text-right">距触发</th>
                  <th className="text-right">距触发%</th>
                  <th>状态</th>
                  <th className="text-right">止损价</th>
                  <th className="text-right">触发→止损</th>
                  <th>买入逻辑</th>
                  <th className="text-right">加入时间</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const riskRatio =
                    r.row.triggerPx !== null && r.row.stopPx !== null && r.row.triggerPx > 0
                      ? (r.row.stopPx - r.row.triggerPx) / r.row.triggerPx
                      : null;
                  return (
                    <tr key={r.row.code}>
                      <td className="num text-ink">{r.row.code}</td>
                      <td>{r.name ?? "—"}</td>
                      <td className="text-ink-2">{r.row.account ?? "—"}</td>
                      <td className="num">
                        <Num v={r.quote?.price ?? null} />
                      </td>
                      <td className="num">
                        <Num v={r.row.triggerPx} />
                      </td>
                      <td className="num">
                        <Num v={r.dist.delta} />
                      </td>
                      <td className="num">
                        <Num v={r.dist.deltaRatio} kind="ratio" />
                      </td>
                      <td>
                        {r.quote === null ? (
                          <Tag>无快照</Tag>
                        ) : r.row.triggerPx === null ? (
                          <Tag>未设触发价</Tag>
                        ) : r.dist.reached ? (
                          <Tag tone="up">已到买点</Tag>
                        ) : (
                          <Tag>等回踩</Tag>
                        )}
                        {r.inconsistent ? (
                          <span className="ml-1">
                            <Tag tone="danger">止损≥触发</Tag>
                          </span>
                        ) : null}
                      </td>
                      <td className="num">
                        <Num v={r.row.stopPx} />
                      </td>
                      <td className="num">
                        {/* 触发价买入到止损的距离 = 这一单的最大计划亏损 */}
                        <Num v={riskRatio} kind="ratio" dir />
                      </td>
                      <td className="text-ink-3 max-w-[24rem] truncate" title={r.row.thesis ?? ""}>
                        {r.row.thesis || "—"}
                      </td>
                      <td className="num text-ink-3">{fmtTs(r.row.addedAt, true)}</td>
                      <td>
                        <WatchpoolRemoveButton code={r.row.code} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {reached.length > 0 ? (
          <div className="mt-3 border border-up/50 bg-up/5 rounded-sm px-3 py-2">
            <span className="text-up font-medium">{reached.length} 只已到买点</span>
            <span className="ml-2 num text-ink-2">
              {reached.map((r) => r.row.code).join(" ")}
            </span>
            <p className="mt-1 text-ink-3 text-[11px]">
              按快照价判断（{fmtTs(snapTs)}）。下单前先在券商 App 里核实实时价 ——
              历史上"复用旧缓存价下判断"是已记录过的误判类型（瞬时价误判）。
            </p>
          </div>
        ) : null}
      </Panel>

      <Panel title="加入观察池" hint="买入条件想清楚了再记，触发价与止损同时写">
        <WatchpoolForm accountIds={accounts(db).filter((a) => a.active).map((a) => a.id)} />
      </Panel>

      <p className="text-ink-3 text-[11px]">
        本页不产生信号，只登记人的判断。策略引擎就绪后候选池会出现在作战台，与本页并存。
      </p>
    </div>
  );
}
