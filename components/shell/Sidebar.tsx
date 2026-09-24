"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { DRAWERS, type DrawerIcon } from "@/lib/ui/drawers";

/**
 * 左侧导航：作战台 + 五个抽屉。可折叠成一列图标（记在本机，下次打开保持）。
 * 数字键 1–5 开对应抽屉（再按一次关掉），0 回作战台，r 刷新；焦点在输入框里时不拦按键。
 */

const PATHS: Record<DrawerIcon | "home", string> = {
  home: "M3 3h8v8H3zM13 3h8v5h-8zM13 10h8v11h-8zM3 13h8v8H3z",
  briefcase: "M3 7h18v13H3zM8 7V4h8v3M3 12h18",
  layers: "M12 3l9 5-9 5-9-5 9-5zM3 13l9 5 9-5M3 17l9 5 9-5",
  bars: "M4 20V10M10 20V4M16 20v-7M22 20H2",
  flask: "M9 3h6M10 3v6l-5 9a2 2 0 0 0 2 3h10a2 2 0 0 0 2-3l-5-9V3M7 15h10",
  gear: "M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1",
};

function Icon({ name }: { name: DrawerIcon | "home" }) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="shrink-0">
      <path d={PATHS[name]} />
    </svg>
  );
}

const KEY = "pt:sidebar-collapsed";

export function Sidebar({ mode, health }: { mode: string; health: { label: string; tone: string } }) {
  const pathname = usePathname();
  const router = useRouter();
  const open = DRAWERS.find(d => pathname === `/${d.slug}`)?.slug ?? null;
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    try { setCollapsed(localStorage.getItem(KEY) === "1"); } catch { /* 隐私模式读不到就默认展开 */ }
  }, []);
  const toggle = () => setCollapsed(c => {
    try { localStorage.setItem(KEY, c ? "0" : "1"); } catch { /* 写不进去就只在本次生效 */ }
    return !c;
  });

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      const tag = t?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || t?.isContentEditable) return;
      const hit = DRAWERS.find(d => d.key === e.key);
      if (hit) { router.push(open === hit.slug ? "/" : `/${hit.slug}`, { scroll: false }); return; }
      if (e.key === "0") router.push("/", { scroll: false });
      if (e.key === "r") router.refresh();
      if (e.key === "[") toggle();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, router]); // eslint-disable-line react-hooks/exhaustive-deps

  const item = (active: boolean) =>
    `flex items-center gap-3 h-10 ${collapsed ? "justify-center px-0" : "px-4"} text-[13px] border-l-2 ${
      active ? "bg-info/15 text-ink border-l-info" : "border-l-transparent text-ink-2 hover:text-ink hover:bg-panel-2"}`;

  return (
    <aside className={`${collapsed ? "w-14" : "w-52"} shrink-0 h-screen sticky top-0 flex flex-col bg-panel border-r border-line transition-[width] duration-150`}>
      <div className={`h-12 flex items-center ${collapsed ? "justify-center" : "px-4 gap-2"} border-b border-line`}>
        {!collapsed ? (
          <Link href="/" scroll={false} className="flex items-baseline gap-2">
            <span className="text-ink text-base font-semibold tracking-widest">候潮</span>
            <span className="text-[10px] text-ink-3 tracking-wide">PANTRADER</span>
          </Link>
        ) : null}
        <button type="button" onClick={toggle} title={collapsed ? "展开导航（[）" : "收起导航（[）"}
          className={`${collapsed ? "" : "ml-auto"} w-7 h-7 flex items-center justify-center rounded-sm text-ink-2 hover:text-ink hover:bg-panel-2`}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
            <path d={collapsed ? "M4 6h16M4 12h16M4 18h16" : "M4 6h16M4 12h10M4 18h16M20 9l-3 3 3 3"} />
          </svg>
        </button>
      </div>

      <nav className="flex-1 py-2 flex flex-col">
        <Link href="/" scroll={false} className={item(open === null)} title="作战台（0）">
          <Icon name="home" />{!collapsed ? <span>作战台</span> : null}
        </Link>
        <div className={`${collapsed ? "mx-3" : "mx-4"} my-2 border-t border-line`} />
        {DRAWERS.map(d => (
          <Link key={d.slug} href={open === d.slug ? "/" : `/${d.slug}`} scroll={false} className={item(open === d.slug)} title={`${d.title}（${d.key}）：${d.hint}`}>
            <Icon name={d.icon} />
            {!collapsed ? (<><span className="flex-1">{d.title}</span><span className="num text-[10px] text-ink-3">{d.key}</span></>) : null}
          </Link>
        ))}
      </nav>

      <div className={`border-t border-line py-3 text-[11px] text-ink-3 ${collapsed ? "px-1 text-center" : "px-4"} flex flex-col gap-1`}>
        {collapsed ? (
          <span className={health.tone} title={`数据源：${health.label}；执行模式 ${mode}`}>●</span>
        ) : (
          <>
            <span>数据源 <span className={health.tone}>{health.label}</span></span>
            <span>执行 <span className="text-ink-2">{mode}</span> · 不自动下单</span>
            <span className="text-ink-3">0 作战台 · 1–5 抽屉 · [ 收起</span>
          </>
        )}
      </div>
    </aside>
  );
}
