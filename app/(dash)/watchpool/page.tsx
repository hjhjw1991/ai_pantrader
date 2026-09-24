import { redirect } from "next/navigation";

/** 观察池并进了「我的股票」抽屉 */
export default function Watchpool() {
  redirect("/positions?tab=1");
}
