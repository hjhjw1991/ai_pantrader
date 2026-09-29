"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { usePathname, useRouter } from "next/navigation";
import { drawerAt } from "@/lib/ui/drawers";

/**
 * 「抽屉已经关掉了」这件事是**全局**的，不属于某一个 DrawerFrame 实例。
 *
 * ── 为什么这几个字不能写进 DrawerFrame 里 ──
 *
 * @drawer 槽在导航过程中会换创作者：
 *   page.tsx      → DrawerContent → <DrawerFrame title="我的股票">
 *   loading.tsx   →               → <DrawerFrame title="加载中…">
 *   default.tsx   → null
 *
 * 三者是互不相识的组件实例，各有一份自己的 state。于是关闭的那一步：
 *
 *   1. 点「关闭」：DrawerFrame(page) 把自己置 closed → 抽屉消失 ✅
 *   2. router.push("/") 开始跑，@drawer 槽暂时无内容可显示 → 亮出 loading.tsx
 *      → **新的那一台** DrawerFrame 挂着 closed=false 出场，屏幕上就是
 *      "抽屉又弹回来一次，标题写着加载中…"
 *   3. 服务端的新 tree 到了，槽换成 default.tsx(null) → 抽屉第二次消失
 *
 * 用户看到的是"关了又弹再关"。所以 closed 必须由**槽外面的人**统一保管：
 * 这里把状态抬到根 layout 的包裹层（app/layout.tsx），槽里换谁当家都读同一份，
 * 侧边栏那条关闭路径也读同一份。
 *
 * ── 为什么复位条件是「进入某个抽屉」，而不是「路径一变」 ──
 *
 * 以前是 `useEffect(() => setClosed(false), [pathname])`：push("/") 完成的那一刻
 * pathname 从 /positions 变成 /，effect 就把 closed 撤了 —— 而那会儿槽里可能
 * 正停在 loading。**这一条单独就能复现那个 bug**，共享状态也救不回来。
 * 只在回头进抽屉时复位：/positions → / 不动，/ → /positions 才开盖。
 */

type Gate = { closed: boolean; close: () => void };

const Ctx = createContext<Gate | null>(null);

export function useDrawerGate(): Gate {
  const v = useContext(Ctx);
  // 抽屉都由根 layout 包出来的 DrawerGate 托管，拿不到 provider 就是用法错了
  if (!v) throw new Error("DrawerFrame 要放在 DrawerGate 里（见 app/layout.tsx）");
  return v;
}

export function DrawerGate({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [closedFlag, setClosedFlag] = useState(false);
  /** 当前开着的抽屉；null = 站在作战台上 */
  const drawer = drawerAt(pathname);

  /**
   * 抽屉已经关掉 = 点过关闭（即时生效的那一下），**或者**地址已经不在任何抽屉里。
   *
   * 后半句是给那些不走 DrawerFrame 关闭按钮的路径兜的：侧边栏的数字键、0 回作战台、
   * 抽屉里的链接、浏览器后退。它们落地时 pathname 变了，槽里那台 DrawerFrame
   * 就该跟着收起来 —— 认地址而不是认哪个组件按下的键，一条规则覆盖所有关法。
   */
  const closed = closedFlag || drawer === null;

  // 回头再开抽屉时把上一次记的"关门"抹掉
  useEffect(() => {
    if (drawer) setClosedFlag(false);
  }, [drawer]);

  const close = useCallback(() => {
    setClosedFlag(true);
    router.push("/", { scroll: false });
  }, [router]);

  const value = useMemo(() => ({ closed, close }), [closed, close]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
