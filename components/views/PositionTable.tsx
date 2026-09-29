"use client";

import { Num } from "@/components/Num";
import { VsMarketTag } from "@/components/MoodBar";
import { SortHead, SortNote, useTableSort, type SortValues } from "@/components/sort-table";
import type { PositionView } from "@/lib/ui/views";

/**
 * 持仓表（每账户一张）。
 *
 * 列定义写在客户端内部 —— Server → Client 的 props 不能带函数，
 * 所以没法由服务端传一份"带渲染函数的列配置"下来。见 sort-table.tsx 顶部注释。
 *
 * 可排序列里**重点**是「市值」与「现价」：
 *   市值 —— 哪几只真正左右这个账户的盈亏，按它排一眼就出来；
 *   现价 —— 单价高的票涨跌同样的百分比，绝对金额差很多，这个视角常被忽略。
 * 其余数值列顺带可排（一次 diff 的成本），没有额外 UI 负担。
 */
export function PositionTable({
  rows, weak, snapNote,
}: {
  rows: PositionView[];
  /** 盘中情绪转弱时为 true：相对强弱标签改色，提示"红的也可能是弱势" */
  weak: boolean;
  /** 快照时点，服务端格式化好的字符串（prop 必须可序列化） */
  snapNote?: string;
}) {
  const values: SortValues<PositionView> = {
    code: (r) => r.position.code,
    name: (r) => r.name,
    qty: (r) => r.position.qty,
    cost: (r) => r.position.cost,
    price: (r) => r.quote?.price ?? null,
    mv: (r) => r.pnl.marketValue,
    pnl: (r) => r.pnl.pnl,
    pnlRatio: (r) => r.pnl.pnlRatio,
    stopPx: (r) => r.position.stopPx,
    stopGap: (r) => r.stopGapRatio,
    vs: (r) => r.vsMarket,
    openDate: (r) => r.position.openDate,
    // 「逻辑」是自由文本，排字典序没有意义 —— 不可排
  };
  const { sort, toggle, clear, rows: shown } = useTableSort(rows, values);
  const COLS: Array<{
    key: string; label: string; right?: boolean; sortable?: boolean; title?: string;
  }> = [
    { key: "code", label: "代码" },
    { key: "name", label: "名称" },
    { key: "qty", label: "数量", right: true },
    { key: "cost", label: "成本", right: true },
    { key: "price", label: "现价", right: true, title: "按最新快照价排序" },
    { key: "mv", label: "市值", right: true, title: "按持仓市值排序（无快照的排最后）" },
    { key: "pnl", label: "浮动盈亏", right: true },
    { key: "pnlRatio", label: "浮动%", right: true },
    { key: "stopPx", label: "止损价", right: true },
    { key: "stopGap", label: "距止损", right: true },
    { key: "vs", label: "vs市场", right: true },
    { key: "openDate", label: "建仓日", right: true },
    { key: "thesis", label: "逻辑", sortable: false },
  ];

  return (
    <>
      {sort ? (
        <SortNote
          label={COLS.find((c) => c.key === sort.key)?.label ?? sort.key}
          dir={sort.dir}
          snapNote={snapNote}
          onClear={clear}
        />
      ) : null}
      <div className="overflow-x-auto">
        <table className="dense">
          <thead>
            <tr>
              {COLS.map((c) => (
                <SortHead
                  key={c.key}
                  label={c.label}
                  right={c.right}
                  title={c.title}
                  sortable={c.sortable !== false}
                  active={sort?.key === c.key}
                  dir={sort?.key === c.key ? sort.dir : undefined}
                  onClick={() => toggle(c.key)}
                />
              ))}
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => (
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
                <td className="num">
                  <VsMarketTag vs={r.vsMarket} weak={weak} />
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
    </>
  );
}
