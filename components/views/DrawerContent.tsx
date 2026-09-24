import { notFound } from "next/navigation";
import { DrawerFrame } from "@/components/drawer/DrawerFrame";
import { drawerOf, type DrawerSlug } from "@/lib/ui/drawers";
import { DrawerTabs } from "@/components/drawer/DrawerTabs";
import PositionsView from "@/components/views/PositionsView";
import WatchpoolView from "@/components/views/WatchpoolView";
import ShadowView from "@/components/views/ShadowView";
import MarketView from "@/components/views/MarketView";
import LedgerView from "@/components/views/LedgerView";
import LabView from "@/components/views/LabView";
import SettingsView from "@/components/views/SettingsView";

const VIEWS: Record<DrawerSlug, () => JSX.Element> = {
  positions: () => <DrawerTabs tabs={[{ label: "持仓与成交", node: <PositionsView /> }, { label: "观察池", node: <WatchpoolView /> }]} />,
  shadow: ShadowView,
  market: MarketView,
  ledger: () => <DrawerTabs tabs={[{ label: "台账 / 胜率", node: <LedgerView /> }, { label: "回测实验室", node: <LabView /> }]} />,
  settings: SettingsView,
};

/** 抽屉路由的统一出口：@drawer 槽里的每个 page.tsx 只调它 */
export function DrawerContent({ slug }: { slug: DrawerSlug }) {
  const d = drawerOf(slug);
  if (d === null) notFound();
  const View = VIEWS[slug];
  return (
    <DrawerFrame title={d.title} hint={d.hint}>
      <View />
    </DrawerFrame>
  );
}
