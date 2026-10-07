"use client";

import { createContext, useContext, useEffect, useState, useTransition } from "react";
import type { ReactNode } from "react";
import { useRouter } from "next/navigation";
import type { ReportSummary } from "@/lib/ui/queries";
import { parseArchiveRows } from "@/components/archive-list";

/**
 * 存档列表的同步。
 *
 * 这张表会被三个地方改动：删一份、跑完回测、扫完参数。三处必须让**同一张表**
 * 立刻重画，而不是各自去 router.refresh() 一遍 —— 整页重渲染要重算四年的行数快照
 * （实测 2~8 秒），那几秒里界面上什么都没变，看起来和失败一模一样。
 *
 * 做法是同一段逻辑共用：先问一次列表接口把表格重画，再让服务端重渲染把整页
 * （面板上的份数、其它面板）对齐。临时列表只在服务端新 props 到达之前存在，
 * props 一到就作废 —— 所以它不是第二份状态，只是刷新落地前的一层影子。
 */

interface Store {
  /** null = 没有临时列表，用服务端 props 那份 */
  rows: ReportSummary[] | null;
  setRows: (rows: ReportSummary[]) => void;
}

/** 没有 Provider 时退化成"只刷新页面"：跑得通，只是列表不会立刻重画 */
const NO_STORE: Store = { rows: null, setRows: () => {} };
const Ctx = createContext<Store>(NO_STORE);

export function ArchiveSync({
  serverRows,
  children,
}: {
  serverRows: ReportSummary[];
  children: ReactNode;
}) {
  const [rows, setRows] = useState<ReportSummary[] | null>(null);
  // 服务端的新列表到了，本地这份影子就作废
  useEffect(() => setRows(null), [serverRows]);
  return <Ctx.Provider value={{ rows, setRows }}>{children}</Ctx.Provider>;
}

/** 表格要显示的行：有影子用影子，没有就用服务端那份 */
export function useArchiveRows(serverRows: ReportSummary[]): ReportSummary[] {
  return useContext(Ctx).rows ?? serverRows;
}

/**
 * 刷新存档列表。**删完一份、跑完回测、扫完参数都调这一个。**
 *
 * 返回"列表有没有取到"：取不到就 false，让调用方如实说一句，
 * 而不是假装刷新过了（整页 refresh 仍会发起，最终会一致，但人该知道刚才那一下没成）。
 */
export function useArchiveRefresh() {
  const router = useRouter();
  // router.refresh() 返回 void，等不到它完成，只有 transition 的 pending 说得出
  // "服务端重渲染还在路上"（同 components/forms.tsx 的 useSubmit）
  const [refreshing, startTransition] = useTransition();
  const { setRows } = useContext(Ctx);

  const refresh = async (): Promise<boolean> => {
    const r = await fetch("/api/backtest/reports").catch(() => null);
    const body = r === null ? null : await r.json().catch(() => null);
    const rows = r !== null && r.ok ? parseArchiveRows(body) : null;
    if (rows === null) return false;
    setRows(rows);
    startTransition(() => router.refresh());
    return true;
  };

  return { refresh, refreshing };
}
