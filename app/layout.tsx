import type { Metadata } from "next";
import type { ReactNode } from "react";
import "@/app/globals.css";
import { Nav } from "@/components/Nav";
import { LiveBar } from "@/components/LiveBar";
import { StatusRail } from "@/components/StatusRail";
import { systemStatus } from "@/lib/ui/status";

export const metadata: Metadata = {
  title: "PanTrader",
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
  return (
    <html lang="zh-CN">
      <body className="min-h-screen bg-bg text-ink">
        <Nav />
        <StatusRail s={s} />
        {/* 实时条：1 分钟自刷 + SSE 推送 + 桌面通知 + 立即采集 */}
        <div className="px-3 pt-1">
          <LiveBar />
        </div>
        <main className="p-3">{children}</main>
      </body>
    </html>
  );
}
