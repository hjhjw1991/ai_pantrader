import { NoDatabase, NoRows } from "@/components/EmptyState";
import { Num } from "@/components/Num";
import { KV, Panel } from "@/components/Panel";
import { readDb, dbUnavailable } from "@/lib/ui/db";
import { fmtAmount, fmtPct, dirClass } from "@/lib/ui/format";
import { ztStats } from "@/lib/ui/derive";
import { lastTradingDay, latestLhbDate, latestZtDate, lhbRows, sectorRank, ztPool } from "@/lib/ui/queries";
import { shanghaiParts } from "@/lib/ui/status";

/**
 * 盘面原料：涨停池原始聚合、连板梯队、板块涨幅榜、龙虎榜。
 *
 * 这些是真值的分组计数，不是因子结论 —— 温度计、主线识别等因子在作战台上（带 proxy 标记与 confidence）。
 * 措辞不能混：这里写"涨停池原始聚合"，不写"情绪"。
 */
export default function MarketView() {
  const db = readDb();
  if (!db) return <NoDatabase why={dbUnavailable()} />;
  const tradeDay = lastTradingDay(db, shanghaiParts(new Date()).date);
  const ztDate = latestZtDate(db);
  const zt = ztDate ? ztPool(db, ztDate) : [];
  const stats = ztStats(zt);
  const sectors = tradeDay ? sectorRank(db, tradeDay) : [];
  const lhbDate = latestLhbDate(db);
  const lhb = lhbDate ? lhbRows(db, lhbDate) : [];

  return (
    <div className="flex flex-col gap-3">
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

    </div>
  );
}
