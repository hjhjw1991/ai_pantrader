"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect } from "react";
import { DRAWERS } from "@/lib/ui/drawers";

/**
 * 主导航。作战台是唯一主页，其余都是右侧抽屉。
 * 数字键 1–7 开对应抽屉（再按一次关掉），Esc 关抽屉，r 重取数据。
 *
 * 09:15 是双手在键盘上、眼睛在盘面上的状态，开抽屉不该去找鼠标。
 * 焦点在输入框里时不拦按键，否则在观察池填价格会被跳走。
 */
export function Nav() {
  const pathname = usePathname();
  const router = useRouter();
  const open = DRAWERS.find(d => pathname === `/${d.slug}`)?.slug ?? null;

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      const tag = t?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || t?.isContentEditable) return;
      const hit = DRAWERS.find(d => d.key === e.key);
      if (hit) {
        router.push(open === hit.slug ? "/" : `/${hit.slug}`, { scroll: false });
        return;
      }
      if (e.key === "0") router.push("/", { scroll: false });
      if (e.key === "r") router.refresh();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, router]);

  return (
    <nav className="flex items-stretch gap-0 border-b border-line bg-panel-2 text-[12px]">
      <Link href="/" scroll={false}
        className={`px-3 py-1.5 border-r border-line ${open === null ? "bg-panel text-ink border-b-2 border-b-info" : "text-ink-2 hover:text-ink"}`}>
        <span className="text-ink font-medium">候潮</span>
        <span className="ml-1.5 text-ink-3">作战台</span>
      </Link>
      {DRAWERS.map(d => (
        <Link key={d.slug} href={open === d.slug ? "/" : `/${d.slug}`} scroll={false} title={d.hint}
          className={`px-3 py-1.5 border-r border-line ${open === d.slug ? "bg-panel text-ink border-b-2 border-b-info" : "text-ink-2 hover:text-ink"}`}>
          <span className="text-ink-3 num mr-1.5">{d.key}</span>
          {d.title}
        </Link>
      ))}
      <span className="ml-auto px-3 py-1.5 text-ink-3">1–7 开抽屉 · Esc 关闭 · r 刷新</span>
    </nav>
  );
}
