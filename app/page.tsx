import { redirect } from "next/navigation";

/** 根路径直接进作战台：早上打开浏览器就该是要看的那一页（M2 出口标准） */
export default function Home() {
  redirect("/today");
}
