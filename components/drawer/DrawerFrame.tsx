"use client";

import { useEffect, type ReactNode } from "react";
import { useRouter } from "next/navigation";

/**
 * 右侧抽屉。作战台是唯一的主页，其余功能都从这里滑出来，看完关掉回到盘面。
 *
 * 关闭 = 回到 "/"：抽屉是路由（/positions 等），刷新、收藏、前进后退都成立。
 * Esc 与点遮罩都能关；焦点在输入框里时 Esc 不拦，免得填表填到一半被关掉。
 */
export function DrawerFrame({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  const router = useRouter();
  const close = () => router.push("/", { scroll: false });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <div className="fixed inset-0 z-40 flex justify-end" role="dialog" aria-modal="true" aria-label={title}>
      <button aria-label="关闭" className="absolute inset-0 bg-black/50 cursor-default" onClick={close} />
      <aside className="relative h-full w-[min(1180px,94vw)] bg-bg border-l border-line-2 shadow-2xl flex flex-col">
        <header className="flex items-baseline gap-3 px-4 py-2 border-b border-line bg-panel-2">
          <h1 className="text-ink font-medium">{title}</h1>
          {hint ? <span className="text-ink-3 text-[11px]">{hint}</span> : null}
          <button onClick={close} className="ml-auto text-ink-2 hover:text-ink text-[12px] border border-line-2 rounded-sm px-2 py-0.5">
            关闭 <span className="text-ink-3">Esc</span>
          </button>
        </header>
        <div className="flex-1 overflow-y-auto p-3">{children}</div>
      </aside>
    </div>
  );
}
