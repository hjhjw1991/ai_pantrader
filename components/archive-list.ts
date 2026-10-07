import type { ReportSummary } from "@/lib/ui/queries";

/**
 * 列表接口的响应 → 能用的行；取不到就 null。
 *
 * **必须区分"存档真的被删空了"和"这次没取到"**：前者是 `[]`，后者是 null。
 * 混成一个空数组的话，接口一挂列表就变空 —— 人看到的是"我的档全没了"，
 * 而真实情况是那份档好端端在库里。宁可让表格停在旧内容上，也不能这么报。
 */
export function parseArchiveRows(body: unknown): ReportSummary[] | null {
  const rows = (body as { rows?: unknown } | null | undefined)?.rows;
  return Array.isArray(rows) ? (rows as ReportSummary[]) : null;
}
