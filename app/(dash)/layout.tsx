import type { ReactNode } from "react";

/**
 * 单页骨架：children = 作战台（永远在底下），drawer = 右侧抽屉槽。
 *
 * 抽屉用并行路由 + 拦截路由做：从作战台点开 /positions 时只渲染抽屉槽，
 * 作战台不重算（它一次要 0.3–2.5 秒）、K 线的状态也不丢；直接刷新 /positions 时
 * 走非拦截的那份，照样是"作战台 + 抽屉"。
 */
export default function DashLayout({ children, drawer }: { children: ReactNode; drawer: ReactNode }) {
  return (
    <>
      {children}
      {drawer}
    </>
  );
}
