import { redirect } from "next/navigation";

/** 旧地址：作战台现在就是主页 */
export default function Today() {
  redirect("/");
}
