import { DrawerFrame } from "@/components/drawer/DrawerFrame";

/** 抽屉先滑出来再填内容：点了就有反应，不会像"没点中"。骨架里不放任何数字 */
export default function DrawerLoading() {
  return (
    <DrawerFrame title="加载中…">
      <div className="flex flex-col gap-2 animate-pulse" aria-busy="true">
        {["w-4/5", "w-3/5", "w-2/3", "w-1/2"].map(w => <div key={w} className={`h-3 rounded-sm bg-line ${w}`} />)}
      </div>
    </DrawerFrame>
  );
}
