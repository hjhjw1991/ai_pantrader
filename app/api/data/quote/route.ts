import { ok, parseQuery, withDb } from "@/lib/ui/api";
import { CodesQuerySchema } from "@/lib/ui/validate";
import { latestQuotes, latestQuoteTs } from "@/lib/ui/queries";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * 最新快照。**没有快照的票不会出现在返回里** —— 调用方必须处理缺失，
 * 不要补 0 价：0 价会让"距离买点"算出一个看起来很诱人的数字。
 */
export function GET(req: Request) {
  const codes = parseQuery(req.url, "codes", CodesQuerySchema);
  if (!codes.ok) return codes.res;

  return withDb((db) => {
    const m = latestQuotes(db, codes.value);
    const missing = codes.value.filter((c) => !m.has(c));
    return ok({
      snapshotTs: latestQuoteTs(db),
      quotes: Object.fromEntries(m),
      missing,
      note: "免费非官方接口采集，非交易级；snapshotTs 之后的行情不在此数据里",
    });
  });
}
