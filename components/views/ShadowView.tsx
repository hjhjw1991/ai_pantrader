import { EmptyState, NoDatabase } from "@/components/EmptyState";
import { ShadowPanelBody } from "@/components/ShadowPanel";
import { readDb, dbUnavailable } from "@/lib/ui/db";
import { shadowOverview } from "@/lib/ui/adapters/overview";

/** 影子盘抽屉：完整成绩单、毕业进度、待批提案、切换历史 */
export default function ShadowView() {
  const db = readDb();
  if (!db) return <NoDatabase why={dbUnavailable()} />;
  const v = shadowOverview(db);
  return (
    <div className="flex flex-col gap-3">
      {!v.available ? <EmptyState u={v} /> : <ShadowPanelBody v={v} />}
      <p className="text-ink-3 text-[11px]">命令行同样可用：pnpm shadow:switch（看板 / approve / reject / rollback / add / retire）</p>
    </div>
  );
}
