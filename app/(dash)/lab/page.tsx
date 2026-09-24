import { redirect } from "next/navigation";

/** 回测并进了「复盘与回测」抽屉 */
export default function Lab() {
  redirect("/ledger?tab=1");
}
