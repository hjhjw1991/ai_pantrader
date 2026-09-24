import CockpitView from "@/components/views/CockpitView";

export const dynamic = "force-dynamic";

/** 直接打开 /ledger（刷新、收藏）：底下照样是作战台，抽屉由 @drawer/ledger 叠上去 */
export default function Page() {
  return <CockpitView />;
}
