"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect } from "react";

export const PAGES = [
  { href: "/today", label: "今日作战台", key: "1" },
  { href: "/watchpool", label: "观察池", key: "2" },
  { href: "/positions", label: "持仓管理", key: "3" },
  { href: "/ledger", label: "台账/胜率", key: "4" },
  { href: "/lab", label: "回测实验室", key: "5" },
  { href: "/settings", label: "设置", key: "6" },
] as const;

/**
 * 主导航。数字键 1–6 直达，[ ] 前后翻页，r 重取数据。
 *
 * 09:15 是双手在键盘上、眼睛在盘面上的状态，翻页不该去找鼠标。
 * 焦点在输入框里时不拦按键，否则在观察池填价格会被跳走。
 */
export function Nav() {
  const pathname = usePathname();
  const router = useRouter();

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      const tag = t?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || t?.isContentEditable) return;

      const hit = PAGES.find((p) => p.key === e.key);
      if (hit) {
        router.push(hit.href);
        return;
      }
      const idx = PAGES.findIndex((p) => pathname.startsWith(p.href));
      if (e.key === "[") router.push(PAGES[(idx - 1 + PAGES.length) % PAGES.length].href);
      if (e.key === "]") router.push(PAGES[(idx + 1) % PAGES.length].href);
      if (e.key === "r") router.refresh();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pathname, router]);

  return (
    <nav className="flex items-stretch gap-0 border-b border-line bg-panel-2 text-[12px]">
      {PAGES.map((p) => {
        const active = pathname.startsWith(p.href);
        return (
          <Link
            key={p.href}
            href={p.href}
            className={`px-3 py-1.5 border-r border-line ${
              active ? "bg-panel text-ink border-b-2 border-b-info" : "text-ink-2 hover:text-ink"
            }`}
          >
            <span className="text-ink-3 num mr-1.5">{p.key}</span>
            {p.label}
          </Link>
        );
      })}
      <span className="ml-auto px-3 py-1.5 text-ink-3">1–6 跳页 · [ ] 翻页 · r 刷新</span>
    </nav>
  );
}
