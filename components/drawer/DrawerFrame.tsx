"use client";

import { useEffect, type ReactNode } from "react";
import { useDrawerGate } from "@/components/drawer/DrawerGate";

/**
 * 右侧抽屉的外壳。作战台是唯一的主页，其余功能都从这里滑出来，看完关掉回到盘面。
 *
 * 关闭 = 回到 "/"：抽屉是路由（/positions 等），刷新、收藏、前进后退都成立。
 * Esc 与点遮罩都能关；焦点在输入框里时 Esc 不拦，免得填表填到一半被关掉。
 *
 * ── 关闭为什么要「先撤掉自己，再换路由」 ──
 *
 * "/" 是 force-dynamic，服务端每次都要重算整张作战台（DB 侧实测 640–750ms，
 * dev 里加上渲染与串行化 2–4s；表单刚写入过更慢 —— useSubmit 的 router.refresh()
 * 会把客户端路由缓存整份作废，下一次导航必然重新打到服务端）。
 *
 * 而 App Router 的导航是**整棵树一起提交**的：children 那一格还没算完，
 * drawer 这一格不会先变回空。于是点下去的画面是抽屉停在原地、
 * 内容被换成 @drawer/loading.tsx 的「加载中…」，几秒后才消失 ——
 * 看着就是点了没反应、卡住了再关上。所以先撤掉自己：点击的下一帧抽屉就没了，
 * 底下那次重算照旧发生（数据可能刚被表单改过，本来就该重算），只是不再挡在眼前。
 *
 * ── 这个 closed 不在这儿 ──
 *
 * 状态在 DrawerGate：@drawer 槽在关闭过程中会换到 loading.tsx 那一台上，
 * 那台也有一个 DrawerFrame。各存一份的话，先撤掉的只是第一台，第二台会带着
 * 「加载中…」重新出场 —— 表现就是"关了又弹一次"。详见 DrawerGate 的说明。
 */
export function DrawerFrame({
  title, hint, children,
}: {
  title: string;
  hint?: string;
  children: ReactNode;
}) {
  const { closed, close } = useDrawerGate();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [close]);

  if (closed) return null;
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
