import { err, ok, withDb } from "@/lib/ui/api";
import { countNotifications, notificationsPage } from "@/lib/ui/notify";

export const dynamic = "force-dynamic";
/** better-sqlite3 跑不了 edge */
export const runtime = "nodejs";

/**
 * 通知历史的分页读取。SSE（/api/events）只推页面打开之后的新通知，
 * 刷新一次铃铛就空了 —— 这个路由负责把刷新之前的那部分拿回来。
 *
 * 游标是 id 而不是页码偏 OFFSET：通知在盘中持续写入，OFFSET 会被新插入的行
 * 顶偏，翻到第二页时重复出几条第一页见过的。id 游标不受插入影响。
 */
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;

export function GET(req: Request) {
  const sp = new URL(req.url).searchParams;
  const before = readInt(sp.get("before"), 0, 0, Number.MAX_SAFE_INTEGER);
  if (before === null) return err(400, `参数 before 不合法：${sp.get("before")}`);
  const limit = readInt(sp.get("limit"), DEFAULT_LIMIT, 1, MAX_LIMIT);
  if (limit === null) return err(400, `参数 limit 需要落在 1..${MAX_LIMIT}：${sp.get("limit")}`);

  return withDb((db) =>
    ok({
      items: notificationsPage(db, before, limit),
      /**
       * 给**总量**而不是"剩余"。
       *
       * SSE 一连上来就把最新的 50 条补推了一遍，客户端手上可能早就有比这一页更旧的
       * 数据；服务端无从知道客户端持有哪些 id，在这里算"还剩几条"会把它们重复计入。
       * 给总量，让客户端自己去减 —— `总数 - 已展示数` 恒等成立：
       * 展示的永远是最新的 N 条，没展示的一定都比它们旧。
       */
      total: countNotifications(db),
    })
  );
}

/** 取整数或取不到时为 null（越界按非法处理，不静默夹取数字之外的东西） */
function readInt(raw: string | null, dflt: number, min: number, max: number): number | null {
  if (raw === null || raw.trim() === "") return dflt;
  const v = Number.parseInt(raw, 10);
  if (!Number.isFinite(v) || v < min || v > max) return null;
  return v;
}
