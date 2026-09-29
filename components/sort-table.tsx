"use client";

import { useState } from "react";
import {
  defaultDir, nextSortState, sortRows,
  type SortDir, type SortState, type SortableValue,
} from "@/lib/ui/sort";

/**
 * 表格排序的**客户端**部分：维护"按哪列、哪个方向"，以及与表头的绑定。
 *
 * ── 为什么排序在客户端，而不是服务端按 URL 参数排 ──
 *
 * 这两张表的价格一直在变：TopBar 的 LiveBar 每 1 分钟 router.refresh() 一次，
 * SSE 推来新数据时也会刷。而 router.refresh() 只替换 server-rendered 那部分，
 * **client component 的 state 是保留的** —— 于是"选中某列排序"这件事
 * 能在刷新之后继续成立，新价格一进来就自动按它重排。
 * 这正是"排序结果在每次价格更新后更新"，不需要额外写任何同步代码。
 *
 * 反过来做（URL 参数 + 服务端排）有两个代价：每点一次表头要一趟往返，
 * 而这个页面本身一分钟就重渲染一次；抽屉里的 Link 导航还会把 ?tab= 这套参数搅进去。
 *
 * ── 为什么这里是 cols 而不是「父组件传带渲染函数的列配置」 ──
 *
 * App Router 里 Server → Client 的 props 必须可序列化，**函数传不过去**。
 * 所以每张表的列定义只能写在客户端组件自己内部，共用不了；
 * 真正能共用的是被拆到 `lib/ui/sort.ts` 里的那几条取值规则
 * （无值排最后、相等保留原序），那是唯一会被误读的部分。
 */

/** 列的排序取值。`key → 取值函数`，不带函数的列就是不可排 */
export type SortValues<T> = Record<string, ((r: T) => SortableValue) | undefined>;

export function useTableSort<T>(rows: T[], values: SortValues<T>) {
  const [sort, setSort] = useState<SortState<T> | null>(null);

  function toggle(key: string) {
    const value = values[key];
    if (!value) return;
    setSort((prev) => nextSortState(prev, key, rows, value));
  }

  const value = sort ? values[sort.key] : undefined;
  const shown = value && sort ? sortRows(rows, value, sort.dir) : rows;

  return { sort, toggle, clear: () => setSort(null), rows: shown };
}

/**
 * 可排序的表头单元格。
 *
 * 箭头平时藏着、hover 才显形：13 列的表每一行都挂一个常驻箭头，
 * 视觉噪音比那一列的信息还多。当前排序列的箭头常显 —— 那是状态，不是装饰。
 */
export function SortHead({
  label, active, dir, sortable, title, right, onClick,
}: {
  label: string;
  active: boolean;
  dir?: SortDir;
  sortable: boolean;
  title?: string;
  right?: boolean;
  onClick: () => void;
}) {
  const cls = ["font-normal", right ? "text-right" : "", "whitespace-nowrap"].filter(Boolean).join(" ");
  if (!sortable) {
    return <th className={cls} title={title}>{label}</th>;
  }
  return (
    <th
      className={`${cls} group`}
      title={title ?? `按${label}排序`}
      aria-sort={active ? (dir === "asc" ? "ascending" : "descending") : "none"}
    >
      <button
        type="button"
        onClick={onClick}
        className={`inline-flex items-center gap-0.5 ${right ? "justify-end" : ""} ${
          active ? "text-ink" : "hover:text-ink-2"
        }`}
      >
        {label}
        <span
          className={`text-[10px] ${active ? "text-info" : "text-ink-3 opacity-0 group-hover:opacity-100"}`}
          aria-hidden
        >
          {active ? (dir === "asc" ? "↑" : "↓") : "↕"}
        </span>
      </button>
    </th>
  );
}

/** 排序生效时表格上方的状态条：说清"按什么排、依据哪个时点的价、会不会自己更新" */
export function SortNote({
  label, dir, snapNote, onClear,
}: {
  label: string;
  dir: SortDir;
  /** 快照时点的描述，由服务端格式化好传进来（必须是可序列化的字符串） */
  snapNote?: string;
  onClear: () => void;
}) {
  return (
    <p className="mb-1 text-[11px] text-ink-3">
      已按 <span className="text-ink-2">{label}</span> {dir === "desc" ? "降序" : "升序"}
      {snapNote ? <span className="num"> · {snapNote}</span> : null}
      <span> · 价格刷新后自动按新价重排</span>
      <button type="button" onClick={onClear} className="ml-2 underline hover:text-ink-2">
        恢复原顺序
      </button>
    </p>
  );
}
