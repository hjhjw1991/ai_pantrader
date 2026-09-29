"use client";

import { Num } from "@/components/Num";
import { Tag } from "@/components/Panel";
import { VsMarketTag } from "@/components/MoodBar";
import { SortHead, SortNote, useTableSort, type SortValues } from "@/components/sort-table";
import { WatchpoolRemoveButton } from "@/components/forms";
import { fmtTs } from "@/lib/ui/format";
import type { WatchView } from "@/lib/ui/views";

/**
 * 观察池主表。
 *
 * 「现价」列是这里的重点：同样的回踩幅度，20 块的票和 200 块的票
 * 对应的资金占用与止损金额完全不同，按股价排一眼能看出这一池的心思
 * 是压在高价票上还是分散在低价票上。
 *
 * 「距触发%」也开放排序（顺带的），它回答的是"哪几只最接近买点"——
 * 这个问法比"哪几只最贵"更贴近观察池的用途，两者互不冲突。
 */
/**
 * 触发价买入到止损的距离 = 这一单的最大计划亏损比例。
 *
 * 抽出来是为了让「渲染」和「排序取值」共用同一条算式 ——
 * 各写一遍的话，改了一个另一个没改，会变成"表里显示 -8% 但排序按另一个口径"。
 */
function riskRatioOf(r: WatchView): number | null {
  const t = r.row.triggerPx;
  const s = r.row.stopPx;
  return t !== null && s !== null && t > 0 ? (s - t) / t : null;
}

export function WatchpoolTable({
  rows, moodWeak, snapNote,
}: {
  rows: WatchView[];
  moodWeak: boolean;
  /** 快照时点，服务端格式化好的字符串 */
  snapNote?: string;
}) {
  const values: SortValues<WatchView> = {
    code: (r) => r.row.code,
    name: (r) => r.name,
    account: (r) => r.row.account ?? null,
    price: (r) => r.quote?.price ?? null,
    triggerPx: (r) => r.row.triggerPx,
    delta: (r) => r.dist.delta,
    deltaRatio: (r) => r.dist.deltaRatio,
    vs: (r) => r.vsMarket,
    stopPx: (r) => r.row.stopPx,
    risk: riskRatioOf,
    addedAt: (r) => r.row.addedAt,
  };
  const { sort, toggle, clear, rows: shown } = useTableSort(rows, values);
  const COLS: Array<{
    key: string; label: string; right?: boolean; sortable?: boolean; title?: string; cls?: string;
  }> = [
    { key: "code", label: "代码" },
    /*
     * 「移出」紧跟代码，不放最后一列。
     * 这个视图是装在 `/positions` 抽屉里的，抽屉比主区窄得多，
     * 14 列的表要横向滚动才看得到最后一列 —— 而"移出"就在那一列，
     * 等于这个功能看不见。
     */
    { key: "remove", label: "移出", sortable: false },
    { key: "name", label: "名称" },
    { key: "account", label: "账户" },
    { key: "price", label: "现价", right: true, title: "按股价排序（无快照的排最后）" },
    { key: "triggerPx", label: "触发价", right: true },
    { key: "delta", label: "距触发", right: true },
    { key: "deltaRatio", label: "距触发%", right: true, title: "最接近买点的排前面" },
    { key: "status", label: "状态", sortable: false },
    { key: "vs", label: "vs市场", right: true },
    { key: "stopPx", label: "止损价", right: true },
    { key: "risk", label: "触发→止损", right: true },
    { key: "thesis", label: "买入逻辑", sortable: false },
    { key: "addedAt", label: "加入时间", right: true },
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
            {shown.map((r) => {
              const riskRatio = riskRatioOf(r);
              return (
                <tr key={r.row.code}>
                  <td className="num text-ink">{r.row.code}</td>
                  <td>
                    <WatchpoolRemoveButton code={r.row.code} />
                  </td>
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
                    <VsMarketTag vs={r.vsMarket} weak={moodWeak} />
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
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}
