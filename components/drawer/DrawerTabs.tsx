"use client";

import { useState, type ReactNode } from "react";
import { useSearchParams } from "next/navigation";

/** 抽屉里的页签。两页内容都在服务端渲染好，切页签不回服务端；?tab=1 可直接落在第二页 */
export function DrawerTabs({ tabs }: { tabs: Array<{ label: string; node: ReactNode }> }) {
  const sp = useSearchParams();
  const init = Math.min(tabs.length - 1, Math.max(0, Number(sp.get("tab") ?? 0) || 0));
  const [i, setI] = useState(init);
  return (
    <div className="flex flex-col gap-3">
      <div className="flex gap-1 border-b border-line">
        {tabs.map((t, k) => (
          <button key={t.label} type="button" onClick={() => setI(k)}
            className={`px-3 py-1.5 text-[13px] -mb-px border-b-2 ${k === i ? "border-info text-ink" : "border-transparent text-ink-2 hover:text-ink"}`}>
            {t.label}
          </button>
        ))}
      </div>
      {tabs.map((t, k) => <div key={t.label} hidden={k !== i}>{t.node}</div>)}
    </div>
  );
}
