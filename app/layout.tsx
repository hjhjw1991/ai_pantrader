import type { Metadata } from "next";
import type { ReactNode } from "react";
import "@/app/globals.css";
import { Sidebar } from "@/components/shell/Sidebar";
import { TopBar } from "@/components/shell/TopBar";
import { systemStatus } from "@/lib/ui/status";

export const metadata: Metadata = {
  title: "候潮",
  description: "A股本地量化作战台",
};

/**
 * 全站强制动态渲染。
 *
 * 这是个每分钟都在变的行情界面，任何静态化/缓存都会让页面显示上一次构建时的价。
 * 显示一个过期的价，比不显示危险 —— 用户会照着它下单。
 */
export const dynamic = "force-dynamic";
export const revalidate = 0;

export default function RootLayout({ children }: { children: ReactNode }) {
  const s = systemStatus();
  const health = s.worstHealth === null ? { label: "无记录", tone: "text-ink-3" }
    : s.worstHealth === "ok" ? { label: "正常", tone: "text-down" }
    : s.worstHealth === "failing" ? { label: "高失败率", tone: "text-warn" }
    : { label: s.worstHealth === "stale" ? "陈旧" : "掉线", tone: "text-danger" };
  return (
    <html lang="zh-CN">
      <body className="h-screen overflow-hidden flex bg-bg text-ink">
        <Sidebar mode={s.executionMode === "paper" ? "paper 模拟" : "manual 手工"} health={health} />
        <div className="flex-1 min-w-0 flex flex-col">
          <TopBar s={s} />
          {/* 滚动发生在主区里：侧边栏与顶栏始终在视野里 */}
          <main className="flex-1 overflow-y-auto p-3">{children}</main>
        </div>
      </body>
    </html>
  );
}
