import { z } from "zod";
import { err, ok, parseQuery, withDb } from "@/lib/ui/api";
import { CodeSchema } from "@/lib/ui/validate";
import { dailyBars } from "@/lib/ui/queries";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const NSchema = z.coerce.number().int().min(2).max(2000);

/** 日线。code 经 6 位数字校验后仍只作绑定参数传入，不进 SQL 字符串 */
export function GET(req: Request) {
  const code = parseQuery(req.url, "code", CodeSchema);
  if (!code.ok) return code.res;

  const rawN = new URL(req.url).searchParams.get("n");
  const n = rawN === null ? 250 : NSchema.safeParse(rawN);
  if (n !== 250 && typeof n !== "number" && !n.success) {
    return err(400, "参数 n 不合法（2–2000 的整数）", n.error.issues);
  }
  const limit = typeof n === "number" ? n : n.success ? n.data : 250;

  return withDb((db) => {
    const bars = dailyBars(db, code.value, limit);
    return ok({
      code: code.value,
      // 空数组就是空数组：该票没有日线数据，不补任何合成 bar
      bars: bars.map((b) => ({ date: b.date, o: b.o, h: b.h, l: b.l, c: b.c, vol: b.vol })),
      note: "未复权。2022-05~2023-12 无复权参照（spec R1），跨该区间的比较不可靠",
    });
  });
}
