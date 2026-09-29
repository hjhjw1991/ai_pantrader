import type { Metadata } from "next";
import type { ReactNode } from "react";
import "@/app/globals.css";
import { Sidebar } from "@/components/shell/Sidebar";
import { TopBar } from "@/components/shell/TopBar";
import { DrawerGate } from "@/components/drawer/DrawerGate";
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
    : s.worstHealth === "stale" ? { label: "陈旧", tone: "text-danger" }
    : { label: "掉线", tone: "text-danger" };
  /*
   * DrawerGate 包在最外面，而不是只包抽屉那一格。
   * 侧边栏（数字键 1–5 再按一次、0 回作战台、点已打开的项）也是一条关闭路径，
   * 它和抽屉里的「关闭」按钮必须写同一份"已关闭"，
   * 否则那条路径下抽屉会闪回一次「加载中…」—— 详见 DrawerGate 的说明。
   */
  return (
    <html lang="zh-CN">
      <body className="h-screen overflow-hidden flex bg-bg text-ink">
        <DrawerGate>
          <Sidebar mode={s.executionMode === "paper" ? "paper 模拟" : "manual 手工"} health={health} />
          <div className="flex-1 min-w-0 flex flex-col">
            <TopBar s={s} />
            {/* 滚动发生在主区里：侧边栏与顶栏始终在视野里 */}
            <main className="flex-1 overflow-y-auto p-3">{children}</main>
          </div>
        </DrawerGate>
      </body>
    </html>
  );
}
